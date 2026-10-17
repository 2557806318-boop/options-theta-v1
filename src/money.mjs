import Decimal from "decimal.js";
Decimal.set({ precision: 48, rounding: Decimal.ROUND_HALF_UP });
export const D = (value) => {
  const n = new Decimal(value);
  if (!n.isFinite()) throw Error("NON_FINITE_DECIMAL");
  return n;
};
export const str = (value) =>
  D(value)
    .toFixed(18)
    .replace(/\.?0+$/, "") || "0";
export const min = (...v) => Decimal.min(...v.map(D));
export const max = (...v) => Decimal.max(...v.map(D));
export const floorStep = (q, step) => D(q).div(step).floor().mul(step);
export const ceilStep = (q, step) => D(q).div(step).ceil().mul(step);
export function fee(price, quantity, index, unit, rate = "0.00024") {
  return min(D(index).mul(unit).mul(rate), D(price).mul("0.10")).mul(quantity);
}
export function margin(contract, price, index, quantity, maintenance = false) {
  const otm =
    contract.side === "CALL"
      ? max(D(contract.strikePrice).minus(index), 0)
      : max(D(index).minus(contract.strikePrice), 0);
  const base = maintenance
    ? contract.maintenanceMargin
    : contract.initialMargin;
  const minimum = maintenance
    ? contract.minMaintenanceMargin
    : contract.minInitialMargin;
  if (base == null || minimum == null) throw Error("MARGIN_RULE_MISSING");
  return max(D(index).mul(minimum), D(index).mul(base).minus(otm))
    .mul(contract.unit)
    .plus(price)
    .mul(quantity);
}
export function payoff(legs, quantity, settlement, credit) {
  return legs.reduce((value, leg) => {
    const intrinsic =
      leg.side === "CALL"
        ? max(D(settlement).minus(leg.strikePrice), 0)
        : max(D(leg.strikePrice).minus(settlement), 0);
    return value.plus(
      intrinsic
        .mul(leg.unit)
        .mul(quantity)
        .mul(leg.role === "LONG" ? 1 : -1),
    );
  }, D(credit));
}
