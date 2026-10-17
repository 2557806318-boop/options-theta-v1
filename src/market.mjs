import WebSocket from "ws";
import { normalizeContract } from "./strategy.mjs";
import { volatility } from "./math.mjs";
import { D } from "./money.mjs";
export function normalizeBook(data, previous, receivedAt = Date.now()) {
  const bids = data.bids ?? data.b,
    asks = data.asks ?? data.a;
  if (!Array.isArray(bids) || !Array.isArray(asks))
    throw Error("DEPTH_PROTOCOL_DRIFT");
  const clean = (rows, descending) =>
    rows
      .map((r) => {
        if (r.length < 2 || !D(r[0]).gt(0) || D(r[1]).lt(0))
          throw Error("DEPTH_INVALID");
        return [String(r[0]), String(r[1])];
      })
      .filter((r) => D(r[1]).gt(0))
      .sort((a, b) => D(a[0]).cmp(b[0]) * (descending ? -1 : 1));
  const sourceTime = Number(data.E || data.T || receivedAt),
    updateId = Number(data.u ?? data.lastUpdateId ?? 0);
  if (
    previous &&
    (sourceTime < previous.sourceTime ||
      (updateId && previous.updateId && updateId <= previous.updateId))
  )
    return previous;
  const b = clean(bids, true),
    a = clean(asks, false);
  if (b.length && a.length && D(b[0][0]).gte(a[0][0]))
    throw Error("CROSSED_BOOK");
  return {
    bids: b,
    asks: a,
    receivedAt,
    sourceTime,
    updateId,
    valid: true,
    source: data.e ? "WS_PARTIAL" : "REST",
  };
}
export class Market {
  constructor(api, config, store, latency) {
    this.api = api;
    this.config = config;
    this.store = store;
    this.latency = latency;
    this.contracts = [];
    this.books = new Map();
    this.marks = new Map();
    this.indices = new Map();
    this.candles = new Map();
    this.sockets = new Map();
    this.connected = {};
    this.error = null;
    this.running = false;
    this.subscribed = [];
    this.holdings = [];
    this.timers = [];
    this.rate = null;
    this.account = null;
  }
  async start() {
    this.running = true;
    await this.api.syncTime();
    await this.refreshContracts();
    await Promise.all([
      this.refreshReference(),
      this.loadCandles(),
      this.refreshAccount(),
    ]);
    this.connect(
      "market",
      this.config.wsMarket + "?streams=!index@arr/ethusdt@optionMarkPrice",
      (data) => this.onMarket(data),
    );
    this.connect(
      "spot",
      "wss://stream.binance.com:9443/ws/ethusdt@kline_1m",
      (data) => {
        const k = data.k;
        if (k?.x) {
          this.candles.set(Number(k.t), {
            openTime: Number(k.t),
            closeTime: Number(k.T),
            close: Number(k.c),
          });
          this.store.archive({
            type: "ETHUSDT_COMPLETED_1M",
            candle: this.candles.get(Number(k.t)),
          });
        }
        this.trimCandles();
      },
    );
    await this.refreshSubscriptions();
    this.interval(() => this.refreshReference(), 60000);
    this.interval(
      () => this.refreshContracts().then(() => this.refreshSubscriptions()),
      300000,
    );
    this.interval(() => this.refreshAccount(), 60000);
    this.interval(() => this.refreshSubscriptions(), 30000);
    this.interval(() => this.api.syncTime(), 1800000);
    this.interval(() => {
      this.store.archive({
        at: Date.now(),
        index: Object.fromEntries(this.indices),
        books: Object.fromEntries(this.books),
        marks: Object.fromEntries(
          [...this.marks].filter(([s]) => this.subscribed.includes(s)),
        ),
      });
    }, 1000);
  }
  interval(fn, ms) {
    const timer = setInterval(
      () =>
        Promise.resolve()
          .then(fn)
          .catch((e) => (this.error = e.message)),
      ms,
    );
    timer.unref();
    this.timers.push(timer);
  }
  connect(name, url, handler) {
    const existing = this.sockets.get(name);
    if (existing) {
      existing.removeAllListeners();
      existing.terminate();
    }
    if (!this.running) return;
    const ws = new WebSocket(url, { handshakeTimeout: 8000 });
    this.sockets.set(name, ws);
    this.connected[name] = false;
    let alive = Date.now();
    const heartbeat = setInterval(() => {
      if (Date.now() - alive > 40000) ws.terminate();
      else if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, 20000);
    heartbeat.unref();
    ws.on("open", () => {
      this.connected[name] = true;
      alive = Date.now();
      if (name === "spot")
        this.loadCandles().catch((e) => (this.error = e.message));
      if (name === "depth" && existing)
        Promise.all(
          this.subscribed.map((s) =>
            this.snapshot(s).catch((e) => (this.error = e.message)),
          ),
        ).catch(() => {});
    });
    ws.on("pong", () => (alive = Date.now()));
    ws.on("ping", () => (alive = Date.now()));
    ws.on("message", (raw) => {
      alive = Date.now();
      try {
        const message = JSON.parse(raw.toString()),
          data = message.data ?? message;
        handler(data);
        const timestamp = Array.isArray(data) ? data[0]?.E : data.E;
        if (timestamp) {
          const age = Date.now() + this.api.offset - Number(timestamp);
          this.latency.add("market.source_to_receive", Math.max(0, age));
        }
      } catch (e) {
        this.error = e.message;
        this.invalidate(name);
        ws.terminate();
      }
    });
    ws.on("error", () => {
      this.error = "WS_" + name + "_ERROR";
    });
    ws.on("close", () => {
      clearInterval(heartbeat);
      if (this.sockets.get(name) !== ws) return;
      this.invalidate(name);
      const timer = setTimeout(() => {
        if (this.running) this.connect(name, url, handler);
      }, 3000);
      timer.unref();
    });
  }
  invalidate(name) {
    this.connected[name] = false;
    if (name === "depth") for (const b of this.books.values()) b.valid = false;
    if (name === "market")
      for (const m of this.marks.values()) m.receivedAt = 0;
  }
  onMarket(data) {
    const rows = Array.isArray(data) ? data : [data];
    for (const r of rows) {
      if (r.e === "indexPrice") {
        if (!["ETHUSDT", "BTCUSDT"].includes(r.s) || !D(r.p).gt(0)) continue;
        const previous = this.indices.get(r.s);
        if (!previous || Number(r.E) >= previous.sourceTime)
          this.indices.set(r.s, {
            price: String(r.p),
            receivedAt: Date.now(),
            sourceTime: Number(r.E),
          });
      } else if (r.e === "markPrice") {
        if (!r.s || r.mp == null || r.vo == null)
          throw Error("MARK_PROTOCOL_DRIFT");
        const previous = this.marks.get(r.s);
        if (!previous || Number(r.E) >= previous.sourceTime)
          this.marks.set(r.s, {
            markPrice: r.mp,
            markIV: r.vo,
            riskFreeInterest: r.rf || "0",
            reportedDelta: r.d,
            reportedTheta: r.t,
            receivedAt: Date.now(),
            sourceTime: Number(r.E),
          });
      } else if (r.code) throw Error("WS_SUBSCRIPTION_REJECTED");
    }
  }
  async refreshContracts() {
    const r = await this.api.get(
      "/eapi/v1/exchangeInfo",
      {},
      false,
      undefined,
      1,
    );
    if (!Array.isArray(r.optionSymbols)) throw Error("CONTRACT_PROTOCOL_DRIFT");
    this.contracts = r.optionSymbols
      .filter(
        (x) =>
          x.underlying === "ETHUSDT" &&
          Number(x.expiryDate) > Date.now() - 86400000,
      )
      .map(normalizeContract);
    const limit = r.rateLimits?.find(
      (x) => x.rateLimitType === "REQUEST_WEIGHT" && x.interval === "MINUTE",
    );
    if (limit) this.api.limit = Number(limit.limit);
    await this.store.saveContracts(this.contracts);
  }
  async refreshReference() {
    const [marks, eth, btc] = await Promise.all([
      this.api.get("/eapi/v1/mark"),
      this.api.get(
        "/eapi/v1/index",
        { underlying: "ETHUSDT" },
        false,
        undefined,
        1,
      ),
      this.api.get(
        "/eapi/v1/index",
        { underlying: "BTCUSDT" },
        false,
        undefined,
        1,
      ),
    ]);
    if (!Array.isArray(marks)) throw Error("MARK_REST_PROTOCOL");
    for (const r of marks)
      if (r.symbol.startsWith("ETH-"))
        this.marks.set(r.symbol, {
          ...r,
          receivedAt: Date.now(),
          sourceTime: Date.now(),
        });
    for (const [symbol, row] of [
      ["ETHUSDT", eth],
      ["BTCUSDT", btc],
    ])
      this.indices.set(symbol, {
        price: row.indexPrice,
        receivedAt: Date.now(),
        sourceTime: Number(row.time || Date.now()),
      });
  }
  async refreshAccount() {
    const [account, commission] = await Promise.all([
      this.api.get("/eapi/v1/marginAccount", {}, true, undefined, 3),
      this.api.get("/eapi/v1/commission", {}, true, undefined, 5),
    ]);
    const rows = Array.isArray(commission)
      ? commission
      : commission.commissions;
    const eth = rows?.find((x) => x.underlying === "ETHUSDT");
    if (!eth?.takerFee) throw Error("COMMISSION_PROTOCOL_DRIFT");
    this.rate = {
      taker: String(eth.takerFee),
      maker: String(eth.makerFee),
      at: Date.now(),
    };
    this.account = {
      at: Date.now(),
      canTrade: account.canTrade,
      reduceOnly: account.reduceOnly,
      assets:
        account.asset?.map?.((x) => ({
          asset: x.asset,
          equity: x.equity,
          available: x.available,
        })) ||
        account.assets?.map?.((x) => ({
          asset: x.asset,
          equity: x.equity,
          available: x.available,
        })) ||
        [],
      sellerPermissionVerified: false,
    };
  }
  async loadCandles() {
    const latest = await this.api.get(
      "/api/v3/klines",
      { symbol: "ETHUSDT", interval: "1m", limit: 1000 },
      false,
      "api.binance.com",
      2,
    );
    const earlier = await this.api.get(
      "/api/v3/klines",
      {
        symbol: "ETHUSDT",
        interval: "1m",
        limit: 500,
        endTime: Number(latest[0][0]) - 1,
      },
      false,
      "api.binance.com",
      2,
    );
    for (const r of [...earlier, ...latest])
      if (Number(r[6]) < Date.now())
        this.candles.set(Number(r[0]), {
          openTime: Number(r[0]),
          closeTime: Number(r[6]),
          close: Number(r[4]),
        });
    this.trimCandles();
    this.store.archive({
      type: "ETHUSDT_RV_WARMUP_1M",
      candles: [...this.candles.values()],
    });
  }
  trimCandles() {
    for (const [t] of this.candles)
      if (t < Date.now() - 27 * 3600000) this.candles.delete(t);
  }
  vol() {
    return volatility(
      [...this.candles.values()].sort((a, b) => a.closeTime - b.closeTime),
      Date.now(),
    );
  }
  async refreshSubscriptions() {
    const index = this.indices.get("ETHUSDT");
    if (!index) return;
    const expiry = Math.min(
      ...this.contracts
        .filter((x) => x.expiryDate > Date.now())
        .map((x) => x.expiryDate),
    );
    const nearby = this.contracts
      .filter((x) => x.expiryDate === expiry)
      .sort(
        (a, b) =>
          Math.abs(Number(a.strikePrice) - Number(index.price)) -
          Math.abs(Number(b.strikePrice) - Number(index.price)),
      )
      .slice(0, 40)
      .map((x) => x.symbol);
    const symbols = [...new Set([...nearby, ...this.holdings])].sort();
    if (symbols.join() === this.subscribed.join()) return;
    this.subscribed = symbols;
    for (const symbol of this.books.keys())
      if (!symbols.includes(symbol)) this.books.delete(symbol);
    this.connect(
      "depth",
      this.config.wsPublic +
        "?streams=" +
        symbols.map((s) => s.toLowerCase() + "@depth20@100ms").join("/"),
      (r) => {
        if (!r.s || r.e !== "depthUpdate") throw Error("DEPTH_PROTOCOL_DRIFT");
        const old = this.books.get(r.s),
          book = normalizeBook(r, old);
        this.books.set(r.s, book);
      },
    );
    for (let i = 0; i < symbols.length; i += 4)
      await Promise.all(
        symbols
          .slice(i, i + 4)
          .map((s) => this.snapshot(s).catch((e) => (this.error = e.message))),
      );
  }
  async snapshot(symbol) {
    const start = Date.now();
    const data = await this.api.get(
      "/eapi/v1/depth",
      { symbol, limit: 20 },
      false,
      undefined,
      2,
    );
    const book = normalizeBook(data, null, Date.now());
    const ws = this.books.get(symbol);
    if (ws?.valid && ws.source === "WS_PARTIAL" && ws.receivedAt >= start) {
      const c = this.contracts.find((x) => x.symbol === symbol);
      for (const field of ["bids", "asks"])
        if (
          ws[field][0] &&
          book[field][0] &&
          D(ws[field][0][0]).minus(book[field][0][0]).abs().gt(c.tickSize)
        ) {
          ws.valid = false;
          throw Error("REST_WS_BOOK_DIVERGENCE");
        }
    }
    this.books.set(symbol, book);
    return book;
  }
  status() {
    return {
      connected: this.connected,
      error: this.error,
      apiBudget: {
        used: this.api.used,
        limit: this.api.limit,
        reservedFraction: 0.3,
      },
      clock: {
        offsetMs: this.api.offset,
        uncertaintyMs: this.api.clockUncertaintyMs,
        syncedAt: this.api.clockSyncAt,
        note: "Source-to-receive is a clock-adjusted estimate, not exact one-way network latency",
      },
      index: Object.fromEntries(this.indices),
      volatility: this.vol(),
      contracts: this.contracts.length,
      subscribed: this.subscribed.length,
      freshBooks: [...this.books.values()].filter(
        (b) => b.valid && Date.now() - b.receivedAt < 2000,
      ).length,
      feeRate: this.rate,
      realAccountReadOnly: this.account,
    };
  }
  stop() {
    this.running = false;
    for (const t of this.timers) clearInterval(t);
    for (const ws of this.sockets.values()) ws.terminate();
  }
}
