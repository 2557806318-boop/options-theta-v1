// Floating point is limited to statistical/Greek calculations, never the cash ledger.
export const YEAR_SECONDS = 365 * 86400;
function cdf(x) {
  const z = Math.abs(x),
    t = 1 / (1 + 0.2316419 * z);
  const p =
    1 -
    (Math.exp((-z * z) / 2) / Math.sqrt(2 * Math.PI)) *
      t *
      (0.31938153 +
        t *
          (-0.356563782 +
            t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? p : 1 - p;
}
export function bs({ spot, strike, years, vol, rate = 0, side }) {
  if (
    ![spot, strike, years, vol, rate].every(Number.isFinite) ||
    spot <= 0 ||
    strike <= 0 ||
    years < 0 ||
    vol <= 0
  )
    throw Error("INVALID_GREEK_INPUT");
  if (years === 0)
    return Math.max(side === "CALL" ? spot - strike : strike - spot, 0);
  const st = vol * Math.sqrt(years),
    d1 = (Math.log(spot / strike) + (rate + (vol * vol) / 2) * years) / st,
    d2 = d1 - st;
  return side === "CALL"
    ? spot * cdf(d1) - strike * Math.exp(-rate * years) * cdf(d2)
    : strike * Math.exp(-rate * years) * cdf(-d2) - spot * cdf(-d1);
}
export function greeks(input) {
  const { spot, strike, years, vol, rate = 0, side } = input;
  const price = bs(input);
  if (years <= 0)
    return {
      price,
      delta: side === "CALL" ? (spot > strike ? 1 : 0) : spot < strike ? -1 : 0,
      thetaPerDay: 0,
      gamma: 0,
      vegaPerVol: 0,
    };
  const d1 =
    (Math.log(spot / strike) + (rate + (vol * vol) / 2) * years) /
    (vol * Math.sqrt(years));
  const delta = side === "CALL" ? cdf(d1) : cdf(d1) - 1;
  const dt = Math.min(60 / YEAR_SECONDS, years / 2);
  const thetaPerDay = (bs({ ...input, years: years - dt }) - price) / dt / 365;
  return {
    price,
    delta,
    thetaPerDay,
    gamma:
      Math.exp((-d1 * d1) / 2) /
      (Math.sqrt(2 * Math.PI) * spot * vol * Math.sqrt(years)),
    vegaPerVol:
      ((spot * Math.exp((-d1 * d1) / 2)) / Math.sqrt(2 * Math.PI)) *
      Math.sqrt(years),
  };
}
export function impliedVol(price, input) {
  if (!Number.isFinite(price) || price <= 0 || input.years <= 0) return null;
  let lo = 0.0001,
    hi = 5;
  if (
    price < bs({ ...input, vol: lo }) - 1e-7 ||
    price > bs({ ...input, vol: hi })
  )
    return null;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (bs({ ...input, vol: mid }) < price) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
export function volatility(candles, now = Date.now()) {
  const byTime = new Map(
    candles.filter((c) => c.closeTime < now).map((c) => [c.openTime, c]),
  );
  const rows = [...byTime.values()]
    .sort((a, b) => a.openTime - b.openTime)
    .slice(-1441);
  if (rows.length < 1441 || now - rows.at(-1).closeTime > 120000)
    return { ready: false, reason: "VOLATILITY_WARMUP", minutes: rows.length };
  for (let i = 1; i < rows.length; i++)
    if (rows[i].openTime - rows[i - 1].openTime !== 60000)
      return { ready: false, reason: "VOLATILITY_GAP", minutes: rows.length };
  const returns = rows
    .slice(1)
    .map((r, i) => Math.log(Number(r.close) / Number(rows[i].close)));
  if (!returns.every(Number.isFinite))
    return { ready: false, reason: "VOLATILITY_INVALID" };
  const rv = (n) =>
    Math.sqrt((returns.slice(-n).reduce((s, v) => s + v * v, 0) / n) * 525600);
  const result = {
    ready: true,
    minutes: 1440,
    rv15: rv(15),
    rv1h: rv(60),
    rv6h: rv(360),
    rv24h: rv(1440),
  };
  result.reference = Math.max(result.rv1h, result.rv6h, result.rv24h);
  return result;
}
