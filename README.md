# OANDA Charts — Cloudflare Workers edition

Same charting site (XAU/USD, XAG/USD + 5 major FX pairs) as the VPS
version, rearchitected to run entirely on Cloudflare — no server to
manage.

## How it's different from a normal Node server

Cloudflare Workers don't run a long-lived process, so there's no
Express/ws server holding a permanent connection to OANDA. Instead:

- **Worker** (`src/worker.js`) serves your frontend as static assets and
  handles `/api/instruments` and `/api/candles` by calling OANDA's REST
  API directly, per request.
- **Durable Object** (`PriceHub`, in the same file) is a small piece of
  always-addressable state that holds every visitor's WebSocket
  connection. It uses Cloudflare's **alarm** feature to wake up every 2
  seconds, fetch the latest prices from OANDA's REST pricing endpoint,
  and push them to every connected browser. When nobody's connected, it
  goes dormant and stops polling — you're not paying to poll OANDA with
  no one watching.

This polls every 2 seconds rather than holding a true tick-by-tick
stream (Cloudflare's free outbound-connection-keeps-it-alive behavior
applies to raw sockets/outbound WebSockets, not to a streamed HTTP
response like OANDA's pricing stream uses). For charting purposes a
2-second cadence looks effectively live; if you want, this can be
tightened by changing `POLL_INTERVAL_MS` in `src/worker.js`.

## 1. Get your OANDA credentials

Same as before:
1. OANDA account → **Manage API Access** → generate a token.
2. Note your account ID (`001-001-1234567-001` format).
3. If you've ever pasted a token anywhere public (chat, email, a repo),
   revoke it and generate a fresh one before using it here.

## 2. Install the Cloudflare CLI and log in

```bash
cd oanda-charts-cf
npm install
npx wrangler login
```

This opens a browser to authorize wrangler against your Cloudflare
account (free tier is enough to run this).

## 3. Set your secrets

Secrets are stored encrypted on Cloudflare, never in your code or in
`wrangler.toml`:

```bash
npx wrangler secret put OANDA_API_KEY
# paste your token when prompted, press enter

npx wrangler secret put OANDA_ACCOUNT_ID
# paste your account ID when prompted, press enter
```

`OANDA_ENV` (practice/live) is already set as a plain (non-secret)
variable in `wrangler.toml` — leave it as `practice` unless you mean to
point this at a live funded account.

## 4. Try it locally

```bash
npx wrangler dev
```

This runs the Worker and Durable Object locally (wrangler simulates
both). Open the URL it prints. Note local dev still calls OANDA's real
API with your real credentials — there's no separate "fake" mode.

## 5. Deploy

```bash
npx wrangler deploy
```

Wrangler prints a `*.workers.dev` URL — that's your live site,
immediately reachable by anyone, no DNS setup required.

## 6. Optional: use your own domain

In the Cloudflare dashboard: **Workers & Pages → your worker → Settings
→ Domains & Routes → Add → Custom domain**. Pick a domain/subdomain
already on your Cloudflare account and it's wired up automatically,
HTTPS included.

## Notes

- Every visitor shares the same OANDA REST calls made by the Durable
  Object — you're not exposing your API key to browsers, and you're not
  opening a separate OANDA connection per visitor.
- Use a **practice** account for a publicly-shared site. There's no
  upside to pointing a public charting site at a live funded account,
  and this app never places trades regardless — it only reads prices.
- `wrangler secret put` is the only place your key should ever be
  typed. Never put it in `wrangler.toml`, never paste it in chat.

## Project structure

```
oanda-charts-cf/
  src/
    worker.js      Worker routes + PriceHub Durable Object
  public/
    index.html
    app.js          Chart rendering + live WebSocket updates
    styles.css
  wrangler.toml
  package.json
```
