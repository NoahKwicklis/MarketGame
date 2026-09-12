/* ============================================================
   Widget Exchange — shared game logic
   Used by both the student page (index.html) and the
   instructor dashboard (teacher.html).

   All money is stored as INTEGER CENTS to avoid floating-point
   drift. Prices are shown to students in dollars.

   Data model (Realtime Database), under /games/{ROOMCODE}:
     meta:   { phase, round, totalRounds, roundSeconds,
               roundEndsAt, pauseRemainingMs, createdAt }
     market: { open, params: {a,b,c,d},        // cents
               players: { NAME: {role, q, score, joinedAt} },
               orders:  { NAME: {side, price, ts} } }
     trades: pushId -> { round, buyer, seller, price,
                         buyerMWP, sellerMC, buyerGain,
                         sellerGain, t }                    // cents
   The matching engine runs inside Firebase transactions on the
   /market node, so two students crossing the same resting order
   at the same instant can never both fill it.
   ============================================================ */

(function (global) {
  "use strict";

  // ---------- economics ----------
  // Every trader draws u ~ Uniform[0,1) once, when they join, and that draw
  // is stored on their player record. It maps onto an intercept shift inside
  // instructor-set bounds:
  //   buyer  i: MU_i(q) = (a + aShift_i) - b*q,  aShift_i = aLo + u*(aHi - aLo)
  //   seller j: MC_j(q) = (c + cShift_j) + d*q,  cShift_j = cLo + u*(cHi - cLo)
  // Storing the draw rather than the shift means widening or narrowing the
  // bounds mid-game stretches the population without reshuffling who is the
  // high-value buyer — a clean comparative static rather than a new draw.
  // Bounds default to zero, so a game with no bounds set behaves exactly as
  // the homogeneous version did.
  function shiftA(params, u) {
    if (u == null || !isFinite(u)) return 0;
    const lo = params.aLo || 0;
    const hi = params.aHi == null ? lo : params.aHi;
    return Math.round(lo + u * (hi - lo));
  }
  function shiftC(params, u) {
    if (u == null || !isFinite(u)) return 0;
    const lo = params.cLo || 0;
    const hi = params.cHi == null ? lo : params.cHi;
    return Math.round(lo + u * (hi - lo));
  }

  // Marginal willingness to pay for a buyer's NEXT unit, having bought q already.
  function mwpNext(params, q, u) {
    return params.a + shiftA(params, u) - params.b * (q + 1);
  }
  // Marginal cost of a seller's NEXT unit, having sold q already.
  function mcNext(params, q, u) {
    return params.c + shiftC(params, u) + params.d * (q + 1);
  }

  const MAX_UNITS = 60;          // safety cap on units enumerated per trader

  // Representative-agent closed form: p* = (a*d + b*c)/(b + d). Only correct
  // when the two sides are equal-sized and identical, so it is used purely as
  // a lobby placeholder before anyone has joined.
  function closedForm(params) {
    const p = (params.a * params.d + params.b * params.c) / (params.b + params.d);
    const q = (params.a - p) / params.b;
    return {
      exact: false, price: p, pLo: p, pHi: p, band: 0,
      qTotal: 0, qMin: 0, qTied: 0, qPerBuyer: q, qPerSeller: q, qtyPerPair: q,
      maxSurplus: 0, nBuyers: 0, nSellers: 0
    };
  }

  // Build the aggregate demand and supply step functions by horizontal
  // summation: pool every unit every buyer wants and every unit every seller
  // could make, then sort. The k-th entry of `values` is the price at which
  // the k-th unit of aggregate demand transacts; likewise for `costs`.
  // Exported so the instructor console can plot the very curves the solver
  // reads its answer off.
  function schedules(params, players) {
    const roster = players ? Object.values(players) : [];
    const buyers = roster.filter(p => p && p.role === "buyer");
    const sellers = roster.filter(p => p && p.role !== "buyer");

    const values = [];
    for (const p of buyers) {
      for (let k = 0; k < MAX_UNITS; k++) {
        const v = mwpNext(params, k, p.u);
        if (v <= 0) break;                                 // free disposal
        values.push(v);
      }
    }
    values.sort((x, y) => y - x);
    const vMax = values.length ? values[0] : 0;

    const costs = [];
    for (const p of sellers) {
      for (let k = 0; k < MAX_UNITS; k++) {
        const c = mcNext(params, k, p.u);
        if (c > vMax) break;                               // never worth making
        costs.push(c);
      }
    }
    costs.sort((x, y) => x - y);
    return { values: values, costs: costs, nBuyers: buyers.length, nSellers: sellers.length };
  }

  // Discrete competitive equilibrium for the actual roster in the room.
  // Reads the crossing off the horizontally summed step functions, so it
  // handles unequal sides, heterogeneous intercepts, and the integer nature
  // of widgets, none of which the closed form can.
  function equilibrium(params, players) {
    const sch = schedules(params, players);
    const values = sch.values, costs = sch.costs;
    if (!sch.nBuyers || !sch.nSellers) return closedForm(params);

    // Q* is the largest number of units for which the Q-th most eager unit of
    // demand still values a widget at least as much as the Q-th cheapest unit
    // of supply costs. Walking the two sorted lists in step is the discrete
    // reading of where the curves cross.
    let Q = 0;
    while (Q < values.length && Q < costs.length && values[Q] >= costs[Q]) Q++;

    // Units where value exactly equals cost add nothing to surplus, so whether
    // they trade is arbitrary: Q* is really the range [qMin, Q]. With 12
    // identical buyers and 12 identical sellers every marginal unit ties at
    // once and that range is 12 units wide. Heterogeneous draws collapse it.
    let qMin = 0;
    while (qMin < values.length && qMin < costs.length && values[qMin] > costs[qMin]) qMin++;

    // Any clearing price must be acceptable to the marginal traders who DO
    // trade and unacceptable to the first ones who don't. That gives a band,
    // not a point. With identical traders the band is a whole step wide
    // (every marginal unit tied); random intercepts shrink it to a cent or
    // two, which is the point of the draws.
    const marginalCost  = Q > 0 ? costs[Q - 1] : -Infinity;
    const marginalValue = Q > 0 ? values[Q - 1] : Infinity;
    const nextValue = Q < values.length ? values[Q] : -Infinity;
    const nextCost  = Q < costs.length ? costs[Q] : Infinity;
    let pLo = Math.max(marginalCost, nextValue);
    let pHi = Math.min(marginalValue, nextCost);
    if (!isFinite(pLo) && !isFinite(pHi)) { pLo = pHi = closedForm(params).price; }
    else if (!isFinite(pLo)) pLo = pHi;
    else if (!isFinite(pHi)) pHi = pLo;
    if (pHi < pLo) { const mid = (pLo + pHi) / 2; pLo = pHi = mid; }

    let maxSurplus = 0;
    for (let i = 0; i < Q; i++) maxSurplus += values[i] - costs[i];

    const n = sch.nBuyers + sch.nSellers;
    return {
      exact: true,
      price: (pLo + pHi) / 2, pLo: pLo, pHi: pHi, band: pHi - pLo,
      qTotal: Q, qMin: qMin, qTied: Q - qMin,
      qPerBuyer: Q / sch.nBuyers,
      qPerSeller: Q / sch.nSellers,
      qtyPerPair: n ? (2 * Q) / n : 0,       // mean units per trader
      maxSurplus: maxSurplus,
      nBuyers: sch.nBuyers, nSellers: sch.nSellers
    };
  }

  // ---------- money helpers ----------
  function toCents(x) { return Math.round(Number(x) * 100); }
  function fmt(cents) {
    const sign = cents < 0 ? "-" : "";
    const v = Math.abs(cents);
    return sign + "$" + Math.floor(v / 100) + "." + String(v % 100).padStart(2, "0");
  }

  // ---------- username screening ----------
  const NAME_RE = /^[A-Za-z0-9_]{3,14}$/;
  const RESERVED = ["admin", "teacher", "instructor", "professor", "prof",
    "system", "moderator", "mod", "null", "undefined"];
  // Blocked anywhere inside the leet-normalized name. Extend freely.
  const BANNED = ["fuck", "fuk", "shit", "sh1t", "bitch", "btch", "cunt",
    "dick", "d1ck", "cock", "pussy", "penis", "vagina", "boob",
    "tits", "titty", "anal", "anus", "arse", "asshole", "butthole",
    "porn", "jizz", "milf", "dildo", "whore", "slut",
    "bastard", "damn", "piss", "nigg", "negro",
    "kike", "spic", "chink", "gook", "wetback", "beaner", "fagg", "dyke",
    "tranny", "retard", "rtard", "rape", "rapist", "nazi", "hitler",
    "kkk", "heil", "molest", "pedo", "meth", "cocaine", "heroin"];
  // Short terms that appear inside innocent words ("Passport", "Cucumber",
  // "Essex") — blocked only at the start or end of the normalized name.
  const BANNED_EDGE = ["ass", "cum", "sex", "hoe", "fag", "nig", "tit"];
  const LEET = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "9": "g", "@": "a", "$": "s", "!": "i" };

  function normalizeName(name) {
    let s = String(name).toLowerCase();
    s = s.replace(/[013457 89@$!]/g, ch => LEET[ch] || "");
    s = s.replace(/[^a-z]/g, "");
    const collapsed = s.replace(/(.)\1+/g, "$1");
    return { s, collapsed };
  }

  // Returns null if OK, otherwise a human-readable reason.
  function nameProblem(raw) {
    const name = String(raw || "").trim();
    if (!NAME_RE.test(name)) {
      return "Use 3\u201314 letters, numbers, or underscores (no spaces).";
    }
    const { s, collapsed } = normalizeName(name);
    if (RESERVED.includes(name.toLowerCase())) return "That name is reserved. Pick another.";
    const REJECT = "That name isn\u2019t allowed in class. Pick another.";
    for (const w of BANNED) {
      if (s.includes(w) || collapsed.includes(w)) return REJECT;
    }
    for (const w of BANNED_EDGE) {
      for (const v of [s, collapsed]) {
        if (v === w || v.startsWith(w) || v.endsWith(w)) return REJECT;
      }
    }
    return null;
  }

  // ---------- room codes ----------
  const ROOM_RE = /^[A-Z0-9]{4,8}$/;
  function cleanRoom(raw) {
    return String(raw || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  }
  function randomRoom() {
    const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no easily-confused chars
    let s = "";
    for (let i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }

  // ---------- firebase bootstrap ----------
  let db = null, serverOffset = 0;
  function initFirebase() {
    if (db) return db;
    if (!global.FIREBASE_CONFIG || String(global.FIREBASE_CONFIG.apiKey).startsWith("PASTE")) {
      throw new Error("Firebase is not configured yet. Open firebase-config.js and paste your project\u2019s config (SETUP.md, step 3).");
    }
    firebase.initializeApp(global.FIREBASE_CONFIG);
    db = firebase.database();
    db.ref(".info/serverTimeOffset").on("value", s => { serverOffset = s.val() || 0; });
    return db;
  }
  function serverNow() { return Date.now() + serverOffset; }
  function gameRef(room, child) {
    const base = db.ref("games/" + room);
    return child ? base.child(child) : base;
  }

  // ---------- top-of-book quotes ----------
  function bestQuotes(orders) {
    let bid = null, ask = null;
    if (orders) for (const o of Object.values(orders)) {
      if (!o) continue;
      if (o.side === "bid") { if (bid === null || o.price > bid) bid = o.price; }
      else { if (ask === null || o.price < ask) ask = o.price; }
    }
    return { bid: bid, ask: ask };
  }

  // Record the best bid/ask after a book-changing event, so clients can
  // draw the bid–ask spread over time. Missing side is simply omitted.
  function pushQuote(room, round, orders, ts) {
    const q = bestQuotes(orders);
    const rec = { t: ts || serverNow(), round: round || 0 };
    if (q.bid !== null) rec.bid = q.bid;
    if (q.ask !== null) rec.ask = q.ask;
    return gameRef(room, "quotes").push(rec);
  }

  // ---------- matching engine ----------
  // Pure function applied inside a transaction on /market.
  // Attempts to place `side` order for `name` at `price` (cents).
  // Mutates and returns the market object. Fills `out` with what
  // happened so the caller can record the trade after commit.
  function placeOrderInMarket(market, name, side, price, ts, out) {
    out.status = null; out.trade = null;

    if (!market || !market.players || !market.players[name]) {
      out.status = "no-player"; return market;
    }
    if (!market.open) { out.status = "closed"; return market; }
    const me = market.players[name];
    if (me.role !== (side === "bid" ? "buyer" : "seller")) {
      out.status = "wrong-side"; return market;
    }

    market.orders = market.orders || {};

    // Find best opposing resting order (price priority, then time).
    const oppSide = side === "bid" ? "ask" : "bid";
    let bestName = null, best = null;
    for (const [n, o] of Object.entries(market.orders)) {
      if (!o || o.side !== oppSide || n === name) continue;
      if (best === null) { bestName = n; best = o; continue; }
      const better = oppSide === "ask"
        ? (o.price < best.price || (o.price === best.price && o.ts < best.ts))
        : (o.price > best.price || (o.price === best.price && o.ts < best.ts));
      if (better) { bestName = n; best = o; }
    }

    const crosses = best !== null &&
      (side === "bid" ? price >= best.price : price <= best.price);

    if (crosses) {
      // First-posted rule: execute at the RESTING order's price.
      const tradePrice = best.price;
      const buyerName = side === "bid" ? name : bestName;
      const sellerName = side === "bid" ? bestName : name;
      const buyer = market.players[buyerName];
      const seller = market.players[sellerName];
      const p = market.params;

      const bMWP = mwpNext(p, buyer.q, buyer.u);
      const sMC = mcNext(p, seller.q, seller.u);
      buyer.q += 1; buyer.score += (bMWP - tradePrice);
      seller.q += 1; seller.score += (tradePrice - sMC);

      delete market.orders[bestName];        // resting order consumed
      if (market.orders[name]) delete market.orders[name]; // replaces any old order

      out.status = "traded";
      out.trade = {
        buyer: buyerName, seller: sellerName, price: tradePrice,
        buyerMWP: bMWP, sellerMC: sMC,
        buyerGain: bMWP - tradePrice, sellerGain: tradePrice - sMC
      };
    } else {
      // Rest in the book, replacing this player's previous order.
      market.orders[name] = { side: side, price: price, ts: ts };
      out.status = "rested";
    }
    return market;
  }

  // Public: submit (or revise) an order. Resolves to
  //   {status: 'traded'|'rested'|'closed'|..., trade?}
  // `round` is the caller's current round (fetched if omitted).
  function submitOrder(room, name, side, priceCents, round) {
    const out = {};
    const ts = serverNow();
    return gameRef(room, "market").transaction(m =>
      placeOrderInMarket(m, name, side, priceCents, ts, out)
    ).then(res => {
      if (!res.committed) return { status: "retry" };
      if (out.status !== "traded" && out.status !== "rested") {
        return { status: out.status };          // book unchanged, nothing to log
      }
      const orders = res.snapshot.child("orders").val();
      const roundP = (round != null)
        ? Promise.resolve(round)
        : gameRef(room, "meta/round").once("value").then(s => s.val() || 0);
      return roundP.then(rd => {
        const jobs = [pushQuote(room, rd, orders, ts)];
        if (out.status === "traded") {
          const rec = Object.assign({ round: rd, t: ts }, out.trade);
          jobs.push(gameRef(room, "trades").push(rec));
          return Promise.all(jobs).then(() => ({ status: "traded", trade: rec }));
        }
        return Promise.all(jobs).then(() => ({ status: "rested" }));
      });
    });
  }

  function cancelOrder(room, name, round) {
    return gameRef(room, "market/orders/" + name).remove()
      .then(() => gameRef(room, "market/orders").once("value"))
      .then(s => pushQuote(room, round || 0, s.val()));
  }

  // Public: join a room (or rejoin after a refresh). Balances roles.
  function joinGame(room, name) {
    return gameRef(room, "meta").once("value").then(snap => {
      if (!snap.exists()) throw new Error("Room \u201C" + room + "\u201D was not found. Check the code with your instructor.");
      return gameRef(room, "market").transaction(m => {
        if (!m) return m;                      // shouldn't happen; abort
        m.players = m.players || {};
        if (m.players[name]) return m;         // rejoin, unchanged
        let buyers = 0, sellers = 0;
        for (const p of Object.values(m.players)) {
          if (p.role === "buyer") buyers++; else sellers++;
        }
        m.players[name] = {
          role: buyers <= sellers ? "buyer" : "seller",
          u: Math.random(),                    // their intercept draw, fixed for the game
          q: 0, score: 0, joinedAt: serverNow()
        };
        return m;
      }).then(res => {
        const p = res.snapshot.child("players/" + name).val();
        if (!p) throw new Error("Could not join \u2014 please try again.");
        return p;
      });
    });
  }

  // Re-roll every trader's intercept draw (instructor only, market closed).
  // Use between class sections, or to run the same students against a second
  // independent draw from the same distribution.
  function redrawTypes(room) {
    return gameRef(room, "market").transaction(m => {
      if (!m || m.open) return m;
      if (m.players) for (const p of Object.values(m.players)) p.u = Math.random();
      return m;
    });
  }

  // ---------- CSV helpers (instructor) ----------
  function csvEscape(v) {
    const s = String(v == null ? "" : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function toCSV(rows) {
    return rows.map(r => r.map(csvEscape).join(",")).join("\r\n");
  }
  function downloadText(filename, text) {
    const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  global.WX = {
    mwpNext, mcNext, shiftA, shiftC, schedules, equilibrium, closedForm, redrawTypes,
    toCents, fmt,
    nameProblem, cleanRoom, randomRoom, ROOM_RE,
    initFirebase, serverNow, gameRef,
    submitOrder, cancelOrder, joinGame, placeOrderInMarket,
    bestQuotes, pushQuote,
    toCSV, downloadText
  };
})(window);
