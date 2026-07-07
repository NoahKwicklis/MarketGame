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
                         buyerMU, sellerMC, buyerGain,
                         sellerGain, t }                    // cents
   The matching engine runs inside Firebase transactions on the
   /market node, so two students crossing the same resting order
   at the same instant can never both fill it.
   ============================================================ */

(function (global) {
  "use strict";

  // ---------- economics ----------
  // Marginal utility of a buyer's NEXT unit, having bought q already:
  //   MU(q+1) = a - b*(q+1)
  // Marginal cost of a seller's NEXT unit, having sold q already:
  //   MC(q+1) = c + d*(q+1)
  // (Follows U(Q) = a - b*Q with Q = number bought, per game spec.)
  function muNext(params, q) { return params.a - params.b * (q + 1); }
  function mcNext(params, q) { return params.c + params.d * (q + 1); }

  // Competitive equilibrium with equal-sized, identical sides:
  //   p* = (a*d + b*c) / (b + d),  q* per pair = (a - p*) / b
  function equilibrium(params) {
    const p = (params.a * params.d + params.b * params.c) / (params.b + params.d);
    const q = (params.a - p) / params.b;
    return { price: p, qtyPerPair: q };
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

      const bMU = muNext(p, buyer.q);
      const sMC = mcNext(p, seller.q);
      buyer.q += 1; buyer.score += (bMU - tradePrice);
      seller.q += 1; seller.score += (tradePrice - sMC);

      delete market.orders[bestName];        // resting order consumed
      if (market.orders[name]) delete market.orders[name]; // replaces any old order

      out.status = "traded";
      out.trade = {
        buyer: buyerName, seller: sellerName, price: tradePrice,
        buyerMU: bMU, sellerMC: sMC,
        buyerGain: bMU - tradePrice, sellerGain: tradePrice - sMC
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
    muNext, mcNext, equilibrium, toCents, fmt,
    nameProblem, cleanRoom, randomRoom, ROOM_RE,
    initFirebase, serverNow, gameRef,
    submitOrder, cancelOrder, joinGame, placeOrderInMarket,
    bestQuotes, pushQuote,
    toCSV, downloadText
  };
})(window);
