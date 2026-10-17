import {
  D,
  str,
  min,
  max,
  fee,
  margin,
  floorStep,
  ceilStep,
} from "./money.mjs";
import { greeks, impliedVol, YEAR_SECONDS } from "./math.mjs";
import { POLICY } from "./config.mjs";
export function normalizeContract(row) {
  const lot = row.filters?.find((f) => f.filterType === "LOT_SIZE"),
    price = row.filters?.find((f) => f.filterType === "PRICE_FILTER");
  if (!lot?.stepSize || !price?.tickSize || !row.unit)
    throw Error("CONTRACT_FILTER_MISSING");
  return {
    ...row,
    minQty: lot.minQty || row.minQty,
    maxQty: lot.maxQty || row.maxQty,
    stepSize: lot.stepSize,
    tickSize: price.tickSize,
    minPrice: price.minPrice,
    maxPrice: price.maxPrice,
  };
}
export function bookFill(
  book,
  side,
  quantity,
  limit,
  now = Date.now(),
  maxAge = POLICY.bookMaxAgeMs,
) {
  if (
    !book ||
    !book.valid ||
    book.receivedAt > now ||
    now - book.receivedAt > maxAge
  )
    return { ok: false, reason: "BOOK_STALE" };
  let remaining = D(quantity),
    total = D(0),
    last = null;
  const levels = side === "BUY" ? book.asks : book.bids;
  for (const [p, q] of levels) {
    if (limit != null && (side === "BUY" ? D(p).gt(limit) : D(p).lt(limit)))
      break;
    const take = min(remaining, q);
    total = total.plus(take.mul(p));
    remaining = remaining.minus(take);
    last = p;
    if (remaining.isZero()) break;
  }
  return remaining.gt(0)
    ? { ok: false, reason: "DEPTH_INSUFFICIENT" }
    : {
        ok: true,
        average: str(total.div(quantity)),
        total: str(total),
        worst: last,
      };
}
export function quoteLeg(leg, book, q, index, rate, now) {
  const action = leg.role === "LONG" ? "BUY" : "SELL";
  const fill = bookFill(book, action, q, null, now);
  if (!fill.ok) return fill;
  const limit =
    action === "BUY"
      ? ceilStep(D(fill.worst).plus(leg.tickSize), leg.tickSize)
      : floorStep(D(fill.worst).minus(leg.tickSize), leg.tickSize);
  if (limit.lte(0) || limit.lt(leg.minPrice) || limit.gt(leg.maxPrice))
    return { ok: false, reason: "PRICE_FILTER" };
  const adverseAverage =
    action === "BUY"
      ? D(fill.average).plus(leg.tickSize)
      : D(fill.average).minus(leg.tickSize);
  if (adverseAverage.lte(0)) return { ok: false, reason: "PRICE_FILTER" };
  return {
    ...fill,
    limit: str(limit),
    adverseAverage: str(adverseAverage),
    fee: str(fee(adverseAverage, q, index, leg.unit, rate)),
  };
}
export function evaluateSize(
  candidate,
  q,
  { books, index, equity, rate, now, policy = POLICY, vol },
) {
  const quotes = [];
  let credit = D(0),
    openFees = D(0),
    capital = D(0),
    slippage = D(0),
    closeFees = D(0),
    longSpend = D(0),
    netDelta = 0,
    theta = 0;
  for (const leg of candidate.legs) {
    if (
      D(q).lt(leg.minQty) ||
      D(q).gt(leg.maxQty) ||
      !D(q).mod(leg.stepSize).isZero()
    )
      return { ok: false, reason: "QUANTITY_FILTER" };
    const quote = quoteLeg(leg, books.get(leg.symbol), q, index, rate, now);
    if (!quote.ok) return quote;
    const amount = D(quote.adverseAverage).mul(q),
      f = D(quote.fee);
    credit = credit.plus(amount.mul(leg.role === "SHORT" ? 1 : -1));
    openFees = openFees.plus(f);
    slippage = slippage.plus(D(leg.tickSize).mul(q));
    closeFees = closeFees.plus(D(index).mul(leg.unit).mul(rate).mul(q)); // worst case fee cap deliberately not used for reserve
    if (leg.role === "LONG") {
      longSpend = longSpend.plus(amount).plus(f);
      capital = capital.plus(amount).plus(f);
    } else capital = capital.plus(margin(leg, leg.markPrice, index, q)).plus(f);
    const input = {
      spot: Number(index),
      strike: Number(leg.strikePrice),
      years: (leg.expiryDate - now) / 1000 / YEAR_SECONDS,
      side: leg.side,
      rate: Number(leg.riskFreeInterest || 0),
    };
    const iv = impliedVol(
      Number(quote.adverseAverage) / Number(leg.unit),
      input,
    );
    if (iv == null) return { ok: false, reason: "IV_UNSOLVABLE" };
    if (leg.role === "SHORT" && iv < vol.reference * policy.ivRvRatio)
      return { ok: false, reason: "IV_PREMIUM_INSUFFICIENT" };
    const g = greeks({ ...input, vol: iv });
    if (
      leg.role === "SHORT" &&
      (Math.abs(g.delta) < policy.shortDeltaMin ||
        Math.abs(g.delta) > policy.shortDeltaMax)
    )
      return { ok: false, reason: "SHORT_DELTA_RANGE" };
    netDelta += g.delta * (leg.role === "LONG" ? 1 : -1) * Number(leg.unit);
    theta += g.thetaPerDay * (leg.role === "LONG" ? 1 : -1) * Number(leg.unit);
    quotes.push({ ...quote, symbol: leg.symbol, iv, greeks: g });
  }
  const netCredit = credit.minus(openFees),
    exitReserve = closeFees.plus(slippage),
    failureReserve = closeFees.plus(slippage.mul(2));
  const structural = D(candidate.width)
    .mul(candidate.legs[0].unit)
    .mul(q)
    .minus(credit);
  const risk = max(
    structural.plus(openFees).plus(exitReserve).plus(failureReserve),
    longSpend.plus(failureReserve),
  );
  if (Math.abs(netDelta) > policy.maxNetDelta)
    return { ok: false, reason: "NET_DELTA_LIMIT" };
  if (theta <= 0) return { ok: false, reason: "THETA_NOT_POSITIVE" };
  if (netCredit.lte(0) || netCredit.lt(exitReserve.mul(3)))
    return { ok: false, reason: "CREDIT_COST_RATIO" };
  if (risk.gt(D(equity).mul(policy.riskFraction)))
    return { ok: false, reason: "RISK_5_PERCENT" };
  if (capital.gt(D(equity).mul(policy.capitalFraction)))
    return { ok: false, reason: "GROSS_MARGIN_30_PERCENT" };
  return {
    ok: true,
    quantity: str(q),
    credit: str(credit),
    netCredit: str(netCredit),
    risk: str(risk),
    structuralRisk: str(structural),
    capital: str(capital),
    openFees: str(openFees),
    exitReserve: str(exitReserve),
    failureReserve: str(failureReserve),
    netDelta,
    thetaPerDay: theta * Number(q),
    quotes,
    rank: Number(netCredit.div(risk)),
  };
}
export function selectCandidate({
  contracts,
  marks,
  books,
  index,
  equity,
  rate,
  vol,
  now = Date.now(),
  attempts = {},
  policy = POLICY,
}) {
  const reasons = {};
  const reject = (r) => {
    reasons[r] = (reasons[r] || 0) + 1;
  };
  if (!vol.ready) return { candidate: null, reasons: { [vol.reason]: 1 } };
  if (vol.reference <= 0)
    return { candidate: null, reasons: { VOLATILITY_INVALID: 1 } };
  if (vol.rv15 > vol.rv6h * policy.shockRatio)
    return { candidate: null, reasons: { VOLATILITY_SHOCK: 1 } };
  const rows = contracts.filter(
    (c) =>
      c.underlying === "ETHUSDT" &&
      ["CALL", "PUT"].includes(c.side) &&
      (!c.status || c.status === "TRADING") &&
      c.expiryDate - now >= policy.entryMinHours * 3600000 &&
      c.expiryDate - now <= policy.entryMaxHours * 3600000,
  );
  if (!rows.length)
    return { candidate: null, reasons: { OUTSIDE_2_8_HOUR_WINDOW: 1 } };
  const prepared = [];
  for (const c of rows) {
    const m = marks.get(c.symbol);
    if (!m || now - m.receivedAt > policy.markMaxAgeMs) {
      reject("MARK_STALE");
      continue;
    }
    const b = books.get(c.symbol);
    if (!b?.valid || now - b.receivedAt > policy.bookMaxAgeMs) {
      reject("BOOK_STALE");
      continue;
    }
    prepared.push({
      ...c,
      markPrice: m.markPrice,
      riskFreeInterest: m.riskFreeInterest || "0",
    });
  }
  const spreads = [];
  for (const short of prepared) {
    if (
      short.side === "CALL"
        ? D(short.strikePrice).lte(index)
        : D(short.strikePrice).gte(index)
    )
      continue;
    const shortPrice = books.get(short.symbol)?.bids[0]?.[0];
    if (!shortPrice) continue;
    const input = {
      spot: Number(index),
      strike: Number(short.strikePrice),
      years: (short.expiryDate - now) / 1000 / YEAR_SECONDS,
      rate: Number(short.riskFreeInterest),
      side: short.side,
    };
    const iv = impliedVol(Number(shortPrice) / Number(short.unit), input);
    if (iv == null) continue;
    const g = greeks({ ...input, vol: iv });
    if (
      Math.abs(g.delta) < policy.shortDeltaMin ||
      Math.abs(g.delta) > policy.shortDeltaMax
    ) {
      reject("SHORT_DELTA_RANGE");
      continue;
    }
    // Identify nearest wings using the COMPLETE listed chain; a missing book must not silently select a farther strike.
    const wings = rows
      .filter(
        (x) =>
          x.side === short.side &&
          x.expiryDate === short.expiryDate &&
          D(x.unit).eq(short.unit) &&
          (short.side === "CALL"
            ? D(x.strikePrice).gt(short.strikePrice)
            : D(x.strikePrice).lt(short.strikePrice)),
      )
      .sort(
        (a, b) =>
          Math.abs(Number(a.strikePrice) - Number(short.strikePrice)) -
          Math.abs(Number(b.strikePrice) - Number(short.strikePrice)),
      )
      .slice(0, 2);
    for (const wing of wings) {
      const long = prepared.find((x) => x.symbol === wing.symbol);
      if (long)
        spreads.push({
          short: { ...short, role: "SHORT" },
          long: { ...long, role: "LONG" },
          width: str(D(short.strikePrice).minus(long.strikePrice).abs()),
        });
    }
  }
  let best = null;
  for (const put of spreads.filter((x) => x.short.side === "PUT"))
    for (const call of spreads.filter((x) => x.short.side === "CALL")) {
      if (
        put.short.expiryDate !== call.short.expiryDate ||
        put.width !== call.width ||
        !D(put.short.unit).eq(call.short.unit)
      )
        continue;
      const expiry = put.short.expiryDate;
      if ((attempts[expiry] || 0) >= policy.maxAttemptsPerExpiry) {
        reject("EXPIRY_ATTEMPT_LIMIT");
        continue;
      }
      const c = {
        expiry,
        width: put.width,
        legs: [put.long, call.long, put.short, call.short],
      };
      // Current contracts have equal steps; refuse heterogeneous filters rather than rounding one leg differently.
      if (c.legs.some((x) => x.stepSize !== c.legs[0].stepSize)) {
        reject("STEP_MISMATCH");
        continue;
      }
      const step = D(c.legs[0].stepSize),
        minimum = ceilStep(max(...c.legs.map((x) => x.minQty)), step);
      const unitMargin = c.legs
        .filter((x) => x.role === "SHORT")
        .reduce((s, l) => s.plus(margin(l, l.markPrice, index, 1)), D(0));
      const upper = floorStep(
        min(
          D(equity).mul(policy.capitalFraction).div(unitMargin),
          ...c.legs.map((x) => x.maxQty),
        ),
        step,
      );
      if (upper.lt(minimum)) {
        reject("MINIMUM_COMBINATION_UNAFFORDABLE");
        continue;
      }
      let chosen = null;
      let count = 0;
      for (
        let q = upper;
        q.gte(minimum) && count++ < 10000;
        q = q.minus(step)
      ) {
        const sized = evaluateSize(c, q, {
          books,
          index,
          equity,
          rate,
          now,
          policy,
          vol,
        });
        if (sized.ok) {
          chosen = { ...c, ...sized };
          break;
        }
        reject(sized.reason);
      }
      if (
        chosen &&
        (!best ||
          chosen.rank > best.rank + 1e-12 ||
          (Math.abs(chosen.rank - best.rank) <= 1e-12 &&
            D(chosen.capital).lt(best.capital)))
      )
        best = chosen;
    }
  if (!best && !Object.keys(reasons).length) reject("NO_MATCHING_FOUR_LEGS");
  return { candidate: best, reasons };
}
