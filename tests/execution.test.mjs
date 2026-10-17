import test from "node:test";
import assert from "node:assert/strict";
import { Paper } from "../src/paper.mjs";
import { MemoryStore, initialState, Latencies } from "../src/store.mjs";
import { D, str } from "../src/money.mjs";
const setup = () => {
  const now = Date.now(),
    expiry = now + 6 * 3600000;
  const legs = [
    ["PUT", "LONG", 2425, "1"],
    ["CALL", "LONG", 2575, "1"],
    ["PUT", "SHORT", 2475, "10"],
    ["CALL", "SHORT", 2525, "10"],
  ].map(([side, role, strike, markPrice]) => ({
    symbol: side + role,
    side,
    role,
    strikePrice: String(strike),
    expiryDate: expiry,
    unit: "1",
    tickSize: ".1",
    markPrice,
    initialMargin: ".15",
    minInitialMargin: ".1",
    maintenanceMargin: ".075",
    minMaintenanceMargin: ".05",
  }));
  const books = new Map(
    legs.map((l) => [
      l.symbol,
      {
        valid: true,
        receivedAt: now,
        sourceTime: now,
        bids: [[str(D(l.markPrice).minus(".1")), "1"]],
        asks: [[str(D(l.markPrice).plus(".1")), "1"]],
      },
    ]),
  );
  const market = {
    books,
    indices: new Map([["ETHUSDT", { price: "2500", receivedAt: now }]]),
    rate: { taker: ".00024", at: now },
    marks: new Map(
      legs.map((l) => [
        l.symbol,
        { markPrice: l.markPrice, markIV: ".6", receivedAt: now },
      ]),
    ),
  };
  const candidate = {
    legs,
    quantity: ".01",
    expiry,
    quotes: legs.map((l) => ({ limit: l.role === "LONG" ? "2" : "9" })),
    risk: "1",
    capital: "8",
    netCredit: ".16",
  };
  const store = new MemoryStore(initialState()),
    latency = new Latencies();
  const paper = new Paper(
    store,
    structuredClone(store.state),
    market,
    latency,
    { wait: async () => {}, waitMs: 100 },
  );
  return { paper, store, market, candidate, latency };
};
test("protection always precedes shorts, actual fills debit fees and cash", async () => {
  const { paper, store, candidate } = setup();
  await paper.open(candidate);
  assert.equal(paper.state.group.status, "OPEN");
  const fills = store.events.filter((e) => e.kind === "ORDER_FILLED");
  assert.deepEqual(
    fills.map((e) => e.payload.order.side),
    ["BUY", "BUY", "SELL", "SELL"],
  );
  assert(D(paper.state.fees).gt(0));
  assert.equal(paper.state.realized, "0");
  assert.equal(paper.state.group.positions.length, 4);
});
test("first protection failure causes no short and preserves rejected order", async () => {
  const { paper, store, market, candidate } = setup();
  market.books.get(candidate.legs[0].symbol).asks = [];
  await paper.open(candidate);
  assert.equal(paper.state.group, null);
  assert.equal(paper.state.cash, "100");
  assert.equal(store.events.filter((e) => e.kind === "ORDER_FILLED").length, 0);
  assert(store.events.some((e) => e.kind === "ORDER_FOK_REJECTED"));
});
test("partial construction loss retained; shorts unwind before wings", async () => {
  const { paper, store, market, candidate } = setup();
  market.books.get(candidate.legs[3].symbol).bids = [];
  await paper.open(candidate);
  assert.equal(paper.state.group, null);
  assert(D(paper.state.realized).lt(0));
  const closing = store.events.filter(
    (e) => e.kind === "ORDER_FILLED" && !e.payload.order.opening,
  );
  assert.equal(closing[0].payload.order.side, "BUY");
  assert(closing.slice(1).every((x) => x.payload.order.side === "SELL"));
  assert(store.events.some((e) => e.kind === "GROUP_CLOSED"));
});
test("timeout is UNKNOWN, not automatically retried", async () => {
  const { paper, store, candidate } = setup();
  paper.wait = async () => {
    throw Error("INJECT_TIMEOUT");
  };
  await paper.open(candidate);
  assert.equal(paper.state.group.status, "UNKNOWN");
  const n = store.events.length;
  await paper.manage();
  assert.equal(store.events.length, n);
  await assert.rejects(() => paper.open(candidate));
});
test("database failure, idempotency and restart pending simulation recovery", async () => {
  const { paper, store, candidate } = setup();
  store.fail = true;
  await assert.rejects(() => paper.open(candidate));
  assert.equal(paper.dbFault, true);
  assert.equal(store.events.length, 0);
  store.fail = false;
  await paper.recover();
  paper.dbFault = false;
  await paper.open(candidate);
  const before = paper.state.cash;
  const prior = store.events.find((e) => e.kind === "ORDER_FILLED");
  const next = await store.commit(
    paper.state,
    structuredClone(paper.state),
    prior,
  );
  assert.equal(next.cash, before);
  await paper.mutate("TEST_PENDING", (s) => {
    s.group.status = "BUILDING";
    s.group.pendingOrder = { id: "recovered" };
  });
  await paper.recover();
  assert.equal(paper.state.group.status, "UNWINDING");
  assert.equal(paper.state.group.pendingOrder, null);
});
test("book withdrawal during simulated latency rejects FOK; no phantom fill", async () => {
  for (const ms of [100, 500, 1500]) {
    const { paper, store, market, candidate } = setup();
    paper.waitMs = ms;
    paper.wait = async (delay) => {
      assert.equal(delay, ms);
      market.books.get(candidate.legs[0].symbol).asks = [];
    };
    await paper.open(candidate);
    assert.equal(
      store.events.filter((e) => e.kind === "ORDER_FILLED").length,
      0,
    );
  }
});
test("one to three tick adverse movement with fixed limit rejects or prices honestly", async () => {
  for (const ticks of [1, 2, 3]) {
    const { paper, store, market, candidate } = setup();
    candidate.quotes[0].limit = "1.2";
    let first = true;
    paper.wait = async () => {
      if (first) {
        first = false;
        market.books.get(candidate.legs[0].symbol).asks = [
          [str(D("1.1").plus(D(".1").mul(ticks))), "1"],
        ];
      }
    };
    await paper.open(candidate);
    const fill = store.events.find((e) => e.kind === "ORDER_FILLED");
    if (ticks === 1) assert.equal(fill.payload.fill.average, "1.2");
    else assert.equal(fill, undefined);
  }
});
test("stale market and missing settlement remain pending without guessed cash", async () => {
  const { paper, candidate, market } = setup();
  await paper.open(candidate);
  market.indices.get("ETHUSDT").receivedAt = 0;
  assert.equal(paper.valuation().valid, false);
  await paper.mutate("TEST_EXPIRED", (s) => {
    s.group.expiry = Date.now() - 1000;
  });
  await paper.manage();
  assert.equal(paper.state.group.status, "SETTLEMENT_PENDING");
  const cash = paper.state.cash;
  assert.equal(await paper.settle([]), false);
  assert.equal(paper.state.cash, cash);
});

test("actual 100/500/1500ms injected waits observe withdrawal, not the old snapshot", async () => {
  for (const ms of [100, 500, 1500]) {
    const { paper, store, market, candidate, latency } = setup();
    paper.waitMs = ms;
    paper.wait = async (delay) =>
      new Promise((resolve) => setTimeout(resolve, delay));
    const timer = setTimeout(
      () => (market.books.get(candidate.legs[0].symbol).asks = []),
      30,
    );
    await paper.open(candidate);
    clearTimeout(timer);
    assert.equal(
      store.events.filter((e) => e.kind === "ORDER_FILLED").length,
      0,
    );
    assert(latency.summary()["paper.leg_simulated_wait"].max >= ms * 0.9);
  }
});

test("lost commit acknowledgement recovers exactly one fill and unwinds on restart", async () => {
  const { paper, store, candidate } = setup();
  const original = store.commit.bind(store);
  let injected = false;
  store.commit = async (previous, next, event) => {
    const result = await original(previous, next, event);
    if (event.kind === "ORDER_FILLED" && !injected) {
      injected = true;
      throw Error("ACK_LOST_AFTER_COMMIT");
    }
    return result;
  };
  await assert.rejects(() => paper.open(candidate), /ACK_LOST/);
  assert.equal(paper.state.group.positions.length, 1);
  assert.equal(store.events.filter((e) => e.kind === "ORDER_FILLED").length, 1);
  await paper.recover();
  paper.dbFault = false;
  assert.equal(paper.state.group.status, "UNWINDING");
  await paper.manage();
  assert.equal(paper.state.group, null);
  assert(D(paper.state.realized).lt(0));
});
