import test from "node:test";
import assert from "node:assert/strict";
import { D, str, fee, margin, payoff, floorStep } from "../src/money.mjs";
import {
  bs,
  greeks,
  impliedVol,
  volatility,
  YEAR_SECONDS,
} from "../src/math.mjs";
import {
  bookFill,
  quoteLeg,
  evaluateSize,
  selectCandidate,
} from "../src/strategy.mjs";
import { normalizeBook } from "../src/market.mjs";
import { config } from "../src/config.mjs";
import { ReadOnlyApi } from "../src/network.mjs";
import { Latencies } from "../src/store.mjs";
const now = Date.now(),
  expiry = now + 6 * 3600000;
export function fixture() {
  const legs = [
    ["PUT", "LONG", 2400],
    ["CALL", "LONG", 2600],
    ["PUT", "SHORT", 2450],
    ["CALL", "SHORT", 2550],
  ].map(([side, role, strike]) => ({
    symbol: `ETH-T-${strike}-${side[0]}`,
    underlying: "ETHUSDT",
    side,
    role,
    strikePrice: String(strike),
    expiryDate: expiry,
    unit: "1",
    minQty: ".01",
    maxQty: "100",
    stepSize: ".01",
    tickSize: ".01",
    minPrice: ".01",
    maxPrice: "10000",
    initialMargin: ".15",
    minInitialMargin: ".10",
    maintenanceMargin: ".075",
    minMaintenanceMargin: ".05",
    markPrice: "1",
    riskFreeInterest: "0",
  }));
  const books = new Map(),
    marks = new Map();
  for (const l of legs) {
    const mid = bs({
      spot: 2500,
      strike: Number(l.strikePrice),
      years: (6 * 3600) / YEAR_SECONDS,
      vol: 1,
      side: l.side,
    });
    l.markPrice = String(mid);
    books.set(l.symbol, {
      valid: true,
      receivedAt: Date.now(),
      sourceTime: Date.now(),
      bids: [[str(D(mid).minus(".01")), "10"]],
      asks: [[str(D(mid).plus(".01")), "10"]],
    });
    marks.set(l.symbol, {
      markPrice: String(mid),
      markIV: "1",
      receivedAt: Date.now(),
    });
  }
  return {
    candidate: { legs, width: "50", expiry },
    context: {
      books,
      marks,
      contracts: legs,
      index: "2500",
      rate: ".00024",
      equity: "100",
      vol: { ready: true, reference: 0.2, rv15: 0.2, rv6h: 0.2 },
      now: Date.now(),
    },
    books,
    marks,
    legs,
  };
}
test("decimal precision, lot rounding and fee cap", () => {
  assert.equal(str(D(".1").plus(".2")), ".3".replace(/^\./, "0."));
  assert.equal(str(floorStep(".019", ".01")), "0.01");
  assert.equal(str(fee("1", ".01", "2500", "1", ".00024")), "0.001");
  assert.equal(str(fee("100", ".01", "2500", "1", ".00024")), "0.006");
});
test("ordinary account margin never offsets the wings", () => {
  const l = { ...fixture().legs[2], strikePrice: "2475" };
  assert.equal(str(margin(l, "5", "2500", ".01")), "3.55");
  assert.equal(str(margin(l, "5", "2500", ".01", true)), "1.675");
});
test("four-leg payoff bounded at both tails", () => {
  const f = fixture();
  assert.equal(str(payoff(f.legs, ".01", "2500", ".12")), "0.12");
  assert.equal(str(payoff(f.legs, ".01", "2000", ".12")), "-0.38");
  assert.equal(str(payoff(f.legs, ".01", "3000", ".12")), "-0.38");
  assert.equal(str(payoff(f.legs, ".01", "2425", ".12")), "-0.13");
});
test("independent Greek signs and IV inversion", () => {
  const input = {
    spot: 2500,
    strike: 2525,
    years: (6 * 3600) / YEAR_SECONDS,
    vol: 0.6,
    side: "CALL",
  };
  const g = greeks(input);
  assert(g.delta > 0 && g.delta < 1);
  assert(g.thetaPerDay < 0);
  assert(g.gamma > 0);
  assert(Math.abs(impliedVol(bs(input), input) - 0.6) < 1e-5);
  const epsilon = 0.01;
  const finite =
    (bs({ ...input, spot: 2500 + epsilon }) -
      bs({ ...input, spot: 2500 - epsilon })) /
    (epsilon * 2);
  assert(Math.abs(finite - g.delta) < 0.001);
  assert(greeks({ ...input, side: "PUT" }).delta < 0);
});
test("only completed consecutive 24h candles; future excluded", () => {
  const base = Date.now() - 1442 * 60000,
    rows = Array.from({ length: 1441 }, (_, i) => ({
      openTime: base + i * 60000,
      closeTime: base + (i + 1) * 60000 - 1,
      close: 2500 + Math.sin(i) * 2,
    }));
  assert(volatility(rows, Date.now()).ready);
  assert(!volatility(rows.slice(1), Date.now()).ready);
  assert(
    !volatility(
      rows.filter((_, i) => i !== 100),
      Date.now(),
    ).ready,
  );
  rows.push({
    openTime: Date.now() + 60000,
    closeTime: Date.now() + 120000,
    close: 999999,
  });
  assert(volatility(rows, Date.now()).ready);
});
test("book protocol, stale, duplicate and out of order", () => {
  const b = normalizeBook(
    { b: [["1", "2"]], a: [["2", "3"]], E: 100, u: 2 },
    null,
    100,
  );
  assert.equal(
    normalizeBook({ b: [[".5", "2"]], a: [["2", "3"]], E: 99, u: 1 }, b, 101),
    b,
  );
  assert.throws(() => normalizeBook({ b: [["1"]], a: [] }, null));
  assert.throws(() =>
    normalizeBook({ b: [["3", "1"]], a: [["2", "1"]] }, null),
  );
  assert.equal(bookFill(b, "BUY", "2", "2", 100).total, "4");
  assert.equal(bookFill(b, "BUY", "4", "2", 100).ok, false);
  assert.equal(bookFill(b, "BUY", "2", "2", 5000).reason, "BOOK_STALE");
});
test("one adverse tick and actual-quantity depth", () => {
  const f = fixture(),
    l = f.legs[0],
    b = f.books.get(l.symbol),
    q = quoteLeg(l, b, ".01", "2500", ".00024", Date.now());
  assert(q.ok);
  assert(D(q.adverseAverage).eq(D(b.asks[0][0]).plus(l.tickSize)));
  assert.equal(
    quoteLeg(l, b, "11", "2500", ".00024", Date.now()).reason,
    "DEPTH_INSUFFICIENT",
  );
});
test("quantity, 5% risk, 30% gross margin and 10/30/100U feasibility", () => {
  const { candidate, context } = fixture();
  assert.equal(
    evaluateSize(candidate, ".001", context).reason,
    "QUANTITY_FILTER",
  );
  for (const equity of ["10", "30", "100"]) {
    const r = selectCandidate({ ...context, equity });
    if (r.candidate) {
      assert(D(r.candidate.risk).lte(D(equity).mul(".05")));
      assert(D(r.candidate.capital).lte(D(equity).mul(".30")));
      assert(D(r.candidate.quantity).gte(".01"));
    }
    if (equity === "10") assert.equal(r.candidate, null);
    else assert(r.candidate, JSON.stringify(r.reasons));
  }
  const r = evaluateSize(candidate, "1", context);
  assert.equal(r.ok, false);
});
test("IV premium, shock, attempts and time window are fail closed", () => {
  const f = fixture();
  assert.equal(
    selectCandidate({
      ...f.context,
      vol: { ready: false, reason: "VOLATILITY_WARMUP" },
    }).candidate,
    null,
  );
  assert(
    selectCandidate({
      ...f.context,
      vol: { ready: true, reference: 0.2, rv15: 0.5, rv6h: 0.2 },
    }).reasons.VOLATILITY_SHOCK,
  );
  assert(
    selectCandidate({ ...f.context, now: expiry - 3600000 }).reasons
      .OUTSIDE_2_8_HOUR_WINDOW,
  );
  assert.equal(
    selectCandidate({ ...f.context, attempts: { [expiry]: 2 } }).candidate,
    null,
  );
});
test("live mode and trade endpoint are structurally denied", async () => {
  assert.throws(() => config({ LIVE_ENABLED: "true" }));
  const api = new ReadOnlyApi({}, new Latencies());
  await assert.rejects(() => api.get("/eapi/v1/order"), /DENIED/);
  await assert.rejects(() => api.get("/sapi/v1/asset/transfer"), /DENIED/);
  api.close();
});
