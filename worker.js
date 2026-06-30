const INSTRUMENTS = [
  { id: 'XAU_USD', label: 'XAU/USD', name: 'Gold', decimals: 2 },
  { id: 'XAG_USD', label: 'XAG/USD', name: 'Silver', decimals: 3 },
  { id: 'EUR_USD', label: 'EUR/USD', name: 'Euro', decimals: 5 },
  { id: 'GBP_USD', label: 'GBP/USD', name: 'Pound', decimals: 5 },
  { id: 'USD_JPY', label: 'USD/JPY', name: 'Yen', decimals: 3 },
  { id: 'AUD_USD', label: 'AUD/USD', name: 'Aussie', decimals: 5 },
  { id: 'USD_CAD', label: 'USD/CAD', name: 'Loonie', decimals: 5 }
];

function oandaHost(env) {
  return env.OANDA_ENV === 'live' ? 'api-fxtrade.oanda.com' : 'api-fxpractice.oanda.com';
}

async function fetchCandles(env, instrument, granularity, count) {
  const url = `https://${oandaHost(env)}/v3/instruments/${encodeURIComponent(instrument)}/candles?granularity=${encodeURIComponent(granularity)}&count=${encodeURIComponent(count)}&price=M`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${env.OANDA_API_KEY}` }
  });
  if (!res.ok) {
    throw new Error(`OANDA REST error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return (data.candles || []).map((c) => ({
    time: Math.floor(new Date(c.time).getTime() / 1000),
    open: parseFloat(c.mid.o),
    high: parseFloat(c.mid.h),
    low: parseFloat(c.mid.l),
    close: parseFloat(c.mid.c)
  }));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/instruments') {
      return Response.json(INSTRUMENTS);
    }

    if (url.pathname === '/api/candles') {
      const instrument = url.searchParams.get('instrument');
      const granularity = url.searchParams.get('granularity') || 'M15';
      const count = url.searchParams.get('count') || '150';
      const valid = INSTRUMENTS.some((i) => i.id === instrument);
      if (!valid) {
        return Response.json({ error: 'unknown instrument' }, { status: 400 });
      }
      try {
        const candles = await fetchCandles(env, instrument, granularity, count);
        return Response.json(candles);
      } catch (err) {
        return Response.json({ error: err.message }, { status: 502 });
      }
    }

    if (url.pathname === '/api/status') {
      return Response.json({
        env: env.OANDA_ENV || 'practice',
        configured: Boolean(env.OANDA_API_KEY && env.OANDA_ACCOUNT_ID)
      });
    }

    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('expected websocket', { status: 426 });
      }
      const id = env.PRICE_HUB.idFromName('singleton');
      const stub = env.PRICE_HUB.get(id);
      return stub.fetch(request);
    }

    return env.ASSETS.fetch(request);
  }
};

const POLL_INTERVAL_MS = 2000;

export class PriceHub {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.lastTicks = {};
  }

  async fetch(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ type: 'snapshot', ticks: this.lastTicks }));

    const existingAlarm = await this.ctx.storage.getAlarm();
    if (existingAlarm === null) {
      await this.ctx.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage() {
    // Clients don't send anything meaningful; this server only pushes ticks.
  }

  async webSocketClose(ws, code, reason, wasClean) {
    try { ws.close(code, reason); } catch (err) { /* already closing */ }
  }

  async webSocketError() {
    // Hibernation API drops broken sockets automatically.
  }

  async alarm() {
    const sockets = this.ctx.getWebSockets();

    if (sockets.length === 0) {
      // No one's listening - go dormant instead of polling OANDA for nothing.
      return;
    }

    if (!this.env.OANDA_API_KEY || !this.env.OANDA_ACCOUNT_ID) {
      this.broadcast(sockets, { type: 'status', streamStatus: 'missing-credentials' });
      await this.ctx.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
      return;
    }

    try {
      const instruments = INSTRUMENTS.map((i) => i.id).join(',');
      const url = `https://${oandaHost(this.env)}/v3/accounts/${encodeURIComponent(this.env.OANDA_ACCOUNT_ID)}/pricing?instruments=${encodeURIComponent(instruments)}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.env.OANDA_API_KEY}` }
      });

      if (!res.ok) {
        this.broadcast(sockets, { type: 'status', streamStatus: `error-${res.status}` });
      } else {
        const data = await res.json();
        (data.prices || []).forEach((p) => {
          const bid = parseFloat(p.bids && p.bids[0] && p.bids[0].price);
          const ask = parseFloat(p.asks && p.asks[0] && p.asks[0].price);
          const tick = { bid, ask, mid: (bid + ask) / 2, time: Math.floor(new Date(p.time).getTime() / 1000) };
          this.lastTicks[p.instrument] = tick;
          this.broadcast(sockets, { type: 'price', instrument: p.instrument, tick });
        });
        this.broadcast(sockets, { type: 'status', streamStatus: 'connected' });
      }
    } catch (err) {
      this.broadcast(sockets, { type: 'status', streamStatus: 'disconnected' });
    }

    await this.ctx.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
  }

  broadcast(sockets, payload) {
    const data = JSON.stringify(payload);
    sockets.forEach((ws) => {
      try { ws.send(data); } catch (err) { /* socket gone, hibernation API will clean it up */ }
    });
  }
}
