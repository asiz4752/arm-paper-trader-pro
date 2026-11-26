# ARM Paper Trader Pro

A paper-trading web app for Indian markets: **Intraday index options** (NIFTY, BANKNIFTY, SENSEX) and **Delivery equity**, with live prices from the **Upstox API** and cloud persistence in **Firebase Firestore**. No real orders are ever placed.

Pure static site (HTML + CSS + ES modules). No build step. Deploy on GitHub Pages or Vercel.

## Features

- Dark, responsive dashboard with a live ticker (NIFTY 50, BANK NIFTY, SENSEX, INDIA VIX)
- Summary cards: combined final P&L, intraday (with available margin) and delivery (invested / current value)
- Floating **+ New Trade** button with a smart order ticket
  - Delivery: symbol search, market or limit price, quantity, backdated buy date
  - Intraday options: index chips, expiry, strike (with ATM button), CE/PE, BUY/SELL, lots x lot size, market or limit, trade date/time
  - Live charges preview (brokerage, STT, exchange fee, SEBI, stamp duty, GST) and funds check
- Open / Closed tabs for both segments, live LTP with green/red flash, inline entry-price edit (double-click), Edit, Delete and Exit
- **Target & Stop-loss automation** with toast and sound alert, plus optional intraday auto square-off
- Journal & Analytics: win rate, average win vs loss, profit factor, expectancy, equity curve, CSV export
- **Settings modal** with auto-save on every keystroke (localStorage plus Firestore sync)
- **LIVE ON/OFF** switch; market prices update only while live mode is on

## Quick start

ES modules need `http://`, so don't open `index.html` by double-clicking.

```bash
cd paper-trader-pro
npx serve .            # or: python3 -m http.server 8080
```

Open the printed URL. The app starts with **LIVE OFF** and does not generate dummy market-price updates. Turn live mode on to fetch prices from Upstox.

## 1. Firebase setup (cloud persistence)

1. Go to the [Firebase console](https://console.firebase.google.com) and create a project.
2. **Build, then Firestore Database, then Create database.** Pick a region near you.
3. **Project settings, then Your apps, then Web app (`</>`)**, register an app and copy the `firebaseConfig` snippet.
4. In ARM Paper Trader Pro click the gear icon. Under **Firebase Firestore**, paste the whole snippet into the paste box. The fields fill themselves in. Or fill them one by one.
5. Click **Verify Firebase connection**. The header pill should turn to "Cloud synced".
6. **Security rules.** In the Firestore **Rules** tab, paste the contents of `firestore.rules`.
   - The app has no login. Data lives under `workspaces/{Workspace ID}/...`. A random Workspace ID is generated for you on first run (shown in Settings). It acts like a password, so keep it private.
   - To use the same data on another device, enter the same Firebase config and the same Workspace ID there.
   - If you sync Upstox credentials to Firestore, anyone who learns your Workspace ID can read them. Untick **Also sync Upstox credentials to Firestore** if that worries you.
   - For a quick first test you can temporarily use `allow read, write: if true;`. Remove it afterwards.

Firestore layout:

```
workspaces/{id}/trades/{tradeId}       every open and closed trade
workspaces/{id}/settings/main          capital, preferences, (optionally) Upstox credentials
workspaces/{id}/snapshots/{YYYY-MM-DD} portfolio snapshot, written every ~5 min while the app is open
```

Without Firebase the app works fully offline-first using `localStorage`.

## 2. Upstox setup (live data)

1. Create an app at the [Upstox developer portal](https://account.upstox.com/developer/apps). Note the **API key** and **API secret**, and set a **Redirect URI**.
2. **Get an access token** (either way):
   - **Manual:** open `https://api.upstox.com/v2/login/authorization/dialog?client_id=<API_KEY>&redirect_uri=<REDIRECT_URI>&response_type=code`, log in, copy the `code` from the redirected URL, and exchange it at `POST /v2/login/authorization/token`. Paste the returned `access_token` into Settings.
   - **In-app helper:** Settings, then Upstox API, then *Generate a token from the app*. It needs the CORS proxy below.
3. Paste the token under **Settings, then Upstox API, then Access token**, then click **Test Upstox connection**.
4. Turn the **LIVE ON/OFF** switch in the header on. The pill should read **LIVE · Upstox**.

Upstox access tokens expire daily at about 3:30 AM IST, so regenerate one each trading day. If the token is rejected, live price updates stop and the data pill shows an error. Click the data pill to retry live.

### CORS and the optional proxy

Upstox's REST API may block direct calls from a browser. If you see a "Network/CORS error":

1. Push this folder to GitHub and import it in **Vercel**. The included `api/upstox.js` deploys as a serverless function and only forwards to `api.upstox.com` and `assets.upstox.com`.
2. Paste `https://<your-project>.vercel.app/api/upstox` into **Settings, then App behaviour, then CORS proxy URL**.

GitHub Pages can't run the proxy. Host the proxy on Vercel and point a Pages-hosted app at it.

### How live data works

- Index ticker: `GET /v2/market-quote/quotes`. Open-position and ticket prices: `GET /v2/market-quote/ltp`, polled every 2 s (configurable). This keeps the app a static site with no protobuf decoder. Swapping in the WebSocket v3 feed would only touch `LiveFeed` in `js/upstox-api.js`.
- Option contracts and equity symbols come from Upstox's daily instrument files (`NSE.json.gz`, `BSE.json.gz`). They are cached in IndexedDB and refreshed each day. If they can't be loaded, paste an instrument key (for example `NSE_EQ|INE002A01018`) into the **Instrument key** box.

## 3. Deploy

- **GitHub Pages:** push the folder, then Settings, then Pages, then deploy from the `main` branch root.
- **Vercel:** import the repo (framework preset: *Other*). It also deploys the proxy.

## Charges model (`js/brokerage-calc.js`)

Based on Upstox's published rate card and the Budget 2026 STT change effective 1 April 2026. All rates live in one `RATES` object so you can update them.

| | Delivery | Index options |
|---|---|---|
| Brokerage | lower of Rs 20 or 2.5% per order | flat Rs 20 per order |
| STT | 0.1% on buy and sell | 0.15% of premium on sell |
| Exchange fee | NSE 0.00297% | NSE 0.03503% / BSE 0.0325% of premium |
| SEBI | Rs 10 per crore | Rs 10 per crore |
| Stamp duty | 0.015% on buy | 0.003% on buy |
| GST | 18% on brokerage + exchange + SEBI | same |

Final P&L = Gross P&L minus entry-leg charges minus exit-leg charges. For open positions the exit leg is estimated at the current LTP.

## Things to know

- **Lot sizes** default to NIFTY 65, BANKNIFTY 30 and SENSEX 20, and are editable in Settings. In live mode the real lot size from the Upstox instrument file is used. Check them against current NSE/BSE circulars.
- **Short-option margin** is an approximation (default 11% of strike x quantity), not real SPAN margin. Adjust it in Settings.
- **Fills:** market and limit orders both fill immediately at the displayed or entered price. There is no order book or pending-order queue.
- **Auto square-off** (optional) only fires between your chosen time (default 15:20) and 15:30 IST on weekdays. Exchange holidays aren't modelled.
- Simulated option premiums come from Black-Scholes on a random-walk index. They are for UI testing, not for judging strategies.
- Educational tool only. This is not investment advice.

## Project structure

```
index.html            app shell, modals
style.css             dark theme
js/app.js             dashboard, tables, automation, analytics
js/order-ui.js        "+ New Trade" ticket
js/settings-ui.js     settings modal (auto-save)
js/store.js           settings + trades state, localStorage + Firestore sync
js/upstox-api.js      Upstox REST client, instruments, price feed loop
js/firebase-config.js Firestore wrapper (modular SDK v10)
js/brokerage-calc.js  Indian charges + P&L maths
js/simulator.js       simulation-mode prices
js/constants.js, js/utils.js, js/ui.js
api/upstox.js         optional Vercel CORS proxy
firestore.rules       example security rules
tests/run-tests.mjs   `npm test`: charges, P&L and simulator checks
```
