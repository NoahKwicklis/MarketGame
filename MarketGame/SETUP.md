# Widget Exchange — Setup Guide

A live double-auction market game for principles of economics. Students are
buyers (marginal utility `MU = a − b·Q`) or sellers (marginal cost
`MC = c + d·Q`), trade one widget at a time in a shared order book, and
accumulate surplus as their score. You run rounds, apply demand/supply
shocks, watch prices converge on a live chart, and export everything to CSV.

**Files**

| File | What it is |
|---|---|
| `index.html` | Student trading page (works on laptops and phones) |
| `teacher.html` | Your instructor console (keep this URL to yourself) |
| `styles.css` | Shared styling |
| `shared.js` | Game logic (matching engine, scoring, username filter) |
| `firebase-config.js` | **The only file you edit** — paste your Firebase config here |
| `SETUP.md` | This guide |

Setup is one-time and takes about 15 minutes.

---

## Step 1 — Create a free Firebase project

1. Go to <https://console.firebase.google.com> and sign in with any Google
   account.
2. Click **Create a project** (or "Add project"). Name it anything, e.g.
   `widget-exchange`. You can decline Google Analytics — it isn't needed.
3. Wait for the project to be created and open it.

## Step 2 — Turn on the Realtime Database

1. In the left sidebar: **Build → Realtime Database → Create Database**.
2. Pick the location closest to campus (e.g. `us-central1`) and choose
   **Start in locked mode**. We'll set proper rules next.
3. Open the **Rules** tab of the database and replace everything with:

```json
{
  "rules": {
    "games": {
      "$room": {
        ".read": true,
        ".write": true,
        ".validate": "$room.matches(/^[A-Z0-9]{4,8}$/)"
      }
    }
  }
}
```

4. Click **Publish**.

> **What this means:** anyone who knows a room code can read and write that
> game's data — which is exactly what lets students trade without accounts.
> Treat the game data as public: never store grades or student ID numbers in
> it. A tech-savvy student could in principle tamper with the database from
> the browser console; the CSV trade log makes that visible, and for a
> classroom game this trade-off is standard. Delete old games from the
> **Data** tab whenever you like.

## Step 3 — Paste your config into `firebase-config.js`

1. In Firebase, click the **gear icon → Project settings**, scroll to
   **Your apps**, and click the **`</>` (Web)** icon to register a web app.
   Nickname it anything; skip Firebase Hosting.
2. Firebase shows a `firebaseConfig` code block. Copy just the object.
3. Open `firebase-config.js` in any text editor and replace the placeholder
   values so it looks like:

```js
window.FIREBASE_CONFIG = {
  apiKey: "AIza....",
  authDomain: "widget-exchange.firebaseapp.com",
  databaseURL: "https://widget-exchange-default-rtdb.firebaseio.com",
  projectId: "widget-exchange",
  storageBucket: "widget-exchange.appspot.com",
  messagingSenderId: "1234567890",
  appId: "1:1234567890:web:abcdef123456"
};
```

> **Important:** make sure `databaseURL` is present. If the snippet Firebase
> shows omits it, copy the URL shown at the top of the Realtime Database
> **Data** tab (it ends in `firebaseio.com` or `firebasedatabase.app`).
>
> This config is not a secret — it's how browsers find your database, and it
> is safe to commit to a public GitHub repo. Access is governed by the rules
> from Step 2.

## Step 4 — Publish on GitHub Pages

1. Create a new GitHub repository (public), e.g. `widget-exchange`.
2. Upload all six files to the repository root (on github.com: **Add file →
   Upload files**).
3. In the repo: **Settings → Pages → Source: Deploy from a branch**, pick
   `main` and `/ (root)`, then **Save**.
4. After a minute your pages are live at:
   - Students: `https://YOURNAME.github.io/widget-exchange/`
   - You: `https://YOURNAME.github.io/widget-exchange/teacher.html`

The teacher page has no password — it's protected only by the URL not being
announced. Don't link to it from the student page or your syllabus.

## Step 5 — Dry run (5 minutes, before class)

1. Open `teacher.html`, click **Random code**, then **Open room**.
2. Open the student page in two other browser tabs (or your phone) and join
   the same code with two test names — one becomes a buyer, one a seller
   (roles auto-balance).
3. Click **Start round 1** on the console. Post an ask of `6.00` from the
   seller, then a bid of `7.00` from the buyer: they should trade at
   **$6.00** (the resting order's first-posted price), both scores update,
   the trade hits the ticker tape, and a point appears on your chart.
4. Download both CSVs to confirm the export works. Then **Reset game** and
   remove the test players.

---

## Running it in class

1. **Before lecture:** open `teacher.html`, open your room, and set
   parameters. Defaults are `a=12, b=1, c=2, d=1`, 5-minute rounds, 3
   rounds — equilibrium at **p\* = $7**, about **5 trades per student** per
   round. The console shows p\* and q\* live; students never see them.
2. **Announce:** the student URL (or a QR code of
   `.../index.html?room=YOURCODE`, which pre-fills the code) and the room
   code. Vulgar usernames are rejected automatically; you can remove anyone
   from the standings table while the market is closed.
3. **Start the round.** The clock, order book, and ticker sync live on every
   device. Students post one order at a time and can revise or cancel it;
   crossing orders execute at the resting order's price.
4. **Mid-round shocks:** change `a` (demand shock) or `c` (supply shock) and
   click **Apply parameters** — every trade from that instant uses the new
   schedules, and the dashed p\* line on your chart jumps. Watch the market
   chase it.
5. **Between rounds:** quantities reset (so marginal values reset) but
   scores accumulate across rounds. Pause/Resume works mid-round.
6. **After class:** download the **trades CSV** (timestamp, round, buyer,
   seller, price, each side's MU/MC and surplus) and the **standings CSV**,
   then project the convergence chart for the debrief.

### Suggested debrief plot
The trades CSV opens directly in Excel/Sheets. Plot `price` against trade
number, add a horizontal line at p\*, and compare realized total surplus
(sum of `total_surplus`) with the theoretical maximum
`N_pairs × Σ [MU(q) − MC(q)]` for q = 1…q\*.

---

## Troubleshooting

- **"Firebase is not configured yet"** — `firebase-config.js` still has the
  placeholder values. Redo Step 3 and re-upload.
- **"Room not found"** — students typed a code you haven't opened on the
  teacher console, or a typo (codes ignore case and spaces).
- **Everything loads but nothing syncs** — check the Realtime Database rules
  (Step 2) were published, and that `databaseURL` in the config matches the
  URL on the database's Data tab.
- **Campus Wi-Fi blocks it** — rare, but if the school network blocks
  `firebaseio.com`, phones on cellular data will still work.
- **Two students picked the same name** — the second one silently "rejoins"
  as the first (same role and score). Ask students to use distinct names;
  remove an impostor from the standings table if needed.

## Free-tier headroom

Firebase's free (Spark) plan allows 100 simultaneous connections, 1 GB
stored, and 10 GB downloaded per month. A 30-student session uses roughly
30 connections and well under a megabyte of data — you could run this every
lecture all semester without approaching any limit. No credit card is ever
required.
