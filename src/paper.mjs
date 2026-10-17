import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { D, str, min, max, fee, margin } from "./money.mjs";
import { bookFill } from "./strategy.mjs";
import { greeks, YEAR_SECONDS } from "./math.mjs";
import { sleep } from "./network.mjs";
export class Paper {
  constructor(
    store,
    state,
    market,
    latency,
    { wait = sleep, waitMs = 150 } = {},
  ) {
    this.store = store;
    this.state = state;
    this.market = market;
    this.latency = latency;
    this.wait = wait;
    this.waitMs = waitMs;
    this.locked = false;
    this.dbFault = false;
    this.lastRisk = null;
  }
  mutate(kind, update, payload = {}, id = randomUUID()) {
    const task = (this.mutations || Promise.resolve()).then(() =>
      this.commitMutation(kind, update, payload, id),
    );
    this.mutations = task.catch(() => {});
    return task;
  }
  async commitMutation(kind, update, payload = {}, id) {
    const before = this.state,
      next = structuredClone(before);
    update(next);
    try {
      this.state = await this.store.commit(before, next, {
        id,
        kind,
        payload,
        groupId: next.group?.id || before.group?.id,
      });
      this.dbFault = false;
    } catch (e) {
      this.dbFault = true;
      try {
        this.state = await this.store.load();
      } catch {}
      throw e;
    }
  }
  async recover() {
    this.state = await this.store.load();
    const g = this.state.group;
    if (!g) return;
    if (g.pendingOrder) {
      await this.mutate(
        "ORDER_RECOVERED_CANCELLED",
        (s) => {
          s.group.pendingOrder = null;
          s.group.status = "UNWINDING";
          s.group.exitReason = "RESTART_OR_COMMIT_UNKNOWN";
        },
        { previous: g.pendingOrder },
      );
    } else if (g.status === "BUILDING" || g.status === "UNKNOWN")
      await this.mutate("RECOVERY_UNWIND", (s) => {
        s.group.status = "UNWINDING";
        s.group.exitReason = "RESTART_INCOMPLETE_BUILD";
      });
  }
  async open(candidate) {
    if (this.locked || this.dbFault || this.state.paused || this.state.group)
      throw Error("PAPER_ENTRY_LOCKED");
    this.locked = true;
    try {
      const id = randomUUID();
      await this.mutate(
        "GROUP_BUILDING",
        (s) => {
          s.attempts[candidate.expiry] =
            (s.attempts[candidate.expiry] || 0) + 1;
          s.group = {
            id,
            status: "BUILDING",
            createdAt: Date.now(),
            expiry: candidate.expiry,
            candidate,
            positions: [],
            startCash: s.cash,
            fees: "0",
            entryGross: "0",
            entryNet: "0",
            pendingOrder: null,
            attribution: { theta: 0, price: 0, volatility: 0 },
            lastAttribution: null,
          };
        },
        {
          candidate,
          index: this.market.indices.get("ETHUSDT"),
          books: Object.fromEntries(
            candidate.legs.map((l) => [
              l.symbol,
              this.market.books.get(l.symbol),
            ]),
          ),
        },
      );
      for (let i = 0; i < candidate.legs.length; i++) {
        const leg = candidate.legs[i],
          quote = candidate.quotes[i];
        if (this.state.paused) {
          await this.beginExit("PAUSED_DURING_BUILD");
          break;
        }
        const ok = await this.leg(
          leg,
          leg.role === "LONG" ? "BUY" : "SELL",
          candidate.quantity,
          quote.limit,
          true,
        );
        if (!ok) {
          await this.beginExit("BUILD_LEG_FOK_FAILED");
          break;
        }
      }
      if (this.state.group.status === "BUILDING") {
        const g = this.state.group;
        const credit = D(this.state.cash).minus(g.startCash).plus(g.fees);
        if (credit.lte(0)) {
          await this.beginExit("ACTUAL_CREDIT_NONPOSITIVE");
        } else
          await this.mutate(
            "GROUP_OPEN",
            (s) => {
              s.group.status = "OPEN";
              s.group.openedAt = Date.now();
              s.group.entryGross = str(credit);
              s.group.entryNet = str(credit.minus(s.group.fees));
              s.outbox.push({
                id: randomUUID(),
                text: `期权纸盘建仓完成：ETH 铁鹰\n数量 ${candidate.quantity}；净权利金 ${str(credit.minus(g.fees))}U\n预估风险 ${candidate.risk}U；保证金及支出 ${candidate.capital}U\n仅模拟，无真实订单。`,
              });
            },
            { candidate },
          );
      }
      if (this.state.group?.status === "UNWINDING") await this.unwind();
    } finally {
      this.locked = false;
    }
  }
  async leg(leg, side, quantity, limit, opening) {
    const g = this.state.group;
    if (!g) throw Error("NO_GROUP");
    if (opening && leg.role === "SHORT") {
      const protection = g.positions
        .filter(
          (p) =>
            p.leg.role === "LONG" &&
            p.leg.side === leg.side &&
            p.leg.expiryDate === leg.expiryDate,
        )
        .reduce((s, p) => s.plus(p.quantity), D(0));
      const existing = g.positions
        .filter((p) => p.leg.role === "SHORT" && p.leg.side === leg.side)
        .reduce((s, p) => s.plus(p.quantity), D(0));
      if (protection.lt(existing.plus(quantity)))
        throw Error("UNPROTECTED_SHORT_DENIED");
    }
    const order = {
      id: randomUUID(),
      symbol: leg.symbol,
      side,
      quantity,
      limit,
      opening,
      createdAt: Date.now(),
      status: "PENDING_SIMULATION",
    };
    await this.mutate(
      "ORDER_PENDING",
      (s) => {
        s.group.pendingOrder = order;
      },
      { order },
    );
    const start = performance.now();
    try {
      await this.wait(this.waitMs);
    } catch {
      await this.mutate(
        "ORDER_UNKNOWN",
        (s) => {
          s.group.status = "UNKNOWN";
          s.group.pendingOrder.status = "UNKNOWN";
          s.outbox.push({
            id: randomUUID(),
            text: "期权纸盘模拟订单超时，状态 UNKNOWN。已停止重复建仓，需核对审计恢复。没有发送真实订单。",
          });
        },
        { order },
      );
      return false;
    }
    this.latency.add("paper.leg_simulated_wait", performance.now() - start);
    if (this.state.group?.status === "UNKNOWN") return false;
    const book = this.market.books.get(leg.symbol),
      fill = bookFill(book, side, quantity, limit);
    const index = this.market.indices.get("ETHUSDT");
    const rate = this.market.rate;
    if (
      !fill.ok ||
      !index ||
      Date.now() - index.receivedAt > 3000 ||
      !rate ||
      Date.now() - rate.at > 300000
    ) {
      await this.mutate(
        "ORDER_FOK_REJECTED",
        (s) => {
          s.group.pendingOrder = null;
        },
        { order, reason: fill.reason || "REFERENCE_STALE", book },
      );
      return false;
    }
    const f = fee(fill.average, quantity, index.price, leg.unit, rate.taker);
    const cashDelta = D(fill.total)
      .mul(side === "BUY" ? -1 : 1)
      .minus(f);
    if (
      opening &&
      side === "BUY" &&
      D(this.state.cash).lt(D(fill.total).plus(f))
    ) {
      await this.mutate(
        "ORDER_FOK_REJECTED",
        (s) => (s.group.pendingOrder = null),
        { order, reason: "PAPER_CASH_INSUFFICIENT" },
      );
      return false;
    }
    if (opening && side === "SELL") {
      const gross = g.positions
        .filter((p) => p.leg.role === "SHORT")
        .reduce(
          (s, p) =>
            s.plus(
              margin(
                p.leg,
                this.market.marks.get(p.leg.symbol)?.markPrice || p.entryPrice,
                index.price,
                p.quantity,
              ),
            ),
          D(0),
        )
        .plus(
          margin(
            leg,
            this.market.marks.get(leg.symbol)?.markPrice || fill.average,
            index.price,
            quantity,
          ),
        );
      const longCost = g.positions
        .filter((p) => p.leg.role === "LONG")
        .reduce((s, p) => s.plus(D(p.entryPrice).mul(p.quantity)), D(0));
      if (gross.plus(longCost).gt(D(g.startCash).mul(".30"))) {
        await this.mutate(
          "ORDER_FOK_REJECTED",
          (s) => (s.group.pendingOrder = null),
          { order, reason: "BUILD_MARGIN_RECHECK" },
        );
        return false;
      }
    }
    await this.mutate(
      "ORDER_FILLED",
      (s) => {
        s.cash = str(D(s.cash).plus(cashDelta));
        s.fees = str(D(s.fees).plus(f));
        s.group.fees = str(D(s.group.fees).plus(f));
        s.group.pendingOrder = null;
        if (opening)
          s.group.positions.push({
            leg,
            quantity,
            entryPrice: fill.average,
            entryFee: str(f),
          });
        else {
          const p = s.group.positions.find((p) => p.leg.symbol === leg.symbol);
          if (!p || D(p.quantity).lt(quantity))
            throw Error("CLOSE_QUANTITY_MISMATCH");
          p.quantity = str(D(p.quantity).minus(quantity));
          s.group.positions = s.group.positions.filter((p) =>
            D(p.quantity).gt(0),
          );
        }
      },
      {
        order: { ...order, status: "FILLED_SIMULATED" },
        fill,
        fee: str(f),
        cashDelta: str(cashDelta),
        index,
        book,
      },
      order.id + ":fill",
    );
    return true;
  }
  valuation(now = Date.now()) {
    const g = this.state.group;
    if (!g)
      return {
        valid: true,
        equity: this.state.cash,
        pnl: "0",
        initialMargin: "0",
        maintenanceMargin: "0",
        netTheta: 0,
      };
    const index = this.market.indices.get("ETHUSDT");
    if (!index || now - index.receivedAt > 3000)
      return { valid: false, reason: "INDEX_STALE" };
    let value = D(0),
      longValue = D(0),
      closeCost = D(0),
      fees = D(0),
      im = D(0),
      mm = D(0),
      theta = 0,
      maxShortDelta = 0,
      priceGreek = 0,
      volGreek = 0;
    const items = [];
    for (const p of g.positions) {
      const l = p.leg,
        m = this.market.marks.get(l.symbol),
        side = l.role === "SHORT" ? "BUY" : "SELL";
      const f = bookFill(
        this.market.books.get(l.symbol),
        side,
        p.quantity,
        null,
        now,
      );
      if (!f.ok || !m || now - m.receivedAt > 10000)
        return { valid: false, reason: f.reason || "MARK_STALE" };
      const sign = l.role === "LONG" ? 1 : -1,
        amount = D(f.total),
        cost = fee(
          f.average,
          p.quantity,
          index.price,
          l.unit,
          this.market.rate?.taker || ".00024",
        );
      value = value.plus(amount.mul(sign));
      closeCost = closeCost.minus(amount.mul(sign));
      fees = fees.plus(cost);
      if (l.role === "SHORT") {
        im = im.plus(margin(l, m.markPrice, index.price, p.quantity));
        mm = mm.plus(margin(l, m.markPrice, index.price, p.quantity, true));
      } else longValue = longValue.plus(amount);
      const input = {
        spot: Number(index.price),
        strike: Number(l.strikePrice),
        years: Math.max(0, (l.expiryDate - now) / 1000 / YEAR_SECONDS),
        vol: Number(m.markIV || m.volatility || 0.5),
        rate: Number(m.riskFreeInterest || 0),
        side: l.side,
      };
      const greek = greeks(input),
        multiplier = Number(l.unit) * Number(p.quantity) * sign;
      theta += greek.thetaPerDay * multiplier;
      priceGreek += greek.delta * multiplier;
      volGreek += greek.vegaPerVol * multiplier;
      if (l.role === "SHORT")
        maxShortDelta = Math.max(maxShortDelta, Math.abs(greek.delta));
      items.push({ symbol: l.symbol, iv: input.vol, greek, multiplier });
    }
    // Ordinary-account adjusted equity = wallet balance + eligible long-option value.
    // Use executable long bids and deduct estimated closing fees conservatively; shorts are already in the MM formula.
    const equity = D(this.state.cash).plus(value).minus(fees),
      adjustedEquity = D(this.state.cash).plus(longValue).minus(fees);
    return {
      valid: true,
      equity: str(equity),
      adjustedEquity: str(adjustedEquity),
      pnl: str(equity.minus(g.startCash)),
      closeCost: str(closeCost),
      closeFees: str(fees),
      initialMargin: str(im),
      maintenanceMargin: str(mm),
      maintenanceRatio: adjustedEquity.gt(0)
        ? Number(mm.div(adjustedEquity))
        : 1e9,
      netTheta: theta,
      maxShortDelta,
      priceGreek,
      volGreek,
      index: Number(index.price),
      items,
    };
  }
  async beginExit(reason) {
    if (!this.state.group || this.state.group.status === "UNKNOWN") return;
    await this.mutate(
      "EXIT_TRIGGERED",
      (s) => {
        s.group.status = "UNWINDING";
        s.group.exitReason = reason;
      },
      { reason },
    );
  }
  async unwind() {
    const g = this.state.group;
    if (!g || g.status !== "UNWINDING") return;
    const positions = [...g.positions].sort(
      (a, b) =>
        (a.leg.role === "SHORT" ? 0 : 1) - (b.leg.role === "SHORT" ? 0 : 1),
    );
    for (const p of positions) {
      const side = p.leg.role === "SHORT" ? "BUY" : "SELL",
        book = this.market.books.get(p.leg.symbol),
        q = bookFill(book, side, p.quantity, null);
      if (!q.ok) return;
      // Risk exits cross only the displayed book, with a bounded three-tick limit; long wings remain until all shorts are closed.
      const limit = str(
        side === "BUY"
          ? D(q.worst).plus(D(p.leg.tickSize).mul(3))
          : max(D(p.leg.tickSize), D(q.worst).minus(D(p.leg.tickSize).mul(3))),
      );
      if (!(await this.leg(p.leg, side, p.quantity, limit, false))) return;
    }
    if (!this.state.group.positions.length) await this.finish("GROUP_CLOSED");
  }
  async finish(kind) {
    const g = structuredClone(this.state.group),
      pnl = str(D(this.state.cash).minus(g.startCash));
    g.closedFrom = g.status;
    g.status = "CLOSED";
    g.closedAt = Date.now();
    await this.mutate(
      kind,
      (s) => {
        s.realized = str(D(s.realized).plus(pnl));
        s.closed++;
        if (g.openedAt) s.completeClosed = (s.completeClosed || 0) + 1;
        s.group = null;
        s.outbox.push({
          id: randomUUID(),
          text: `期权纸盘已平仓\n原因：${g.exitReason || "OFFICIAL_SETTLEMENT"}\n本组费后盈亏 ${pnl}U；费用 ${g.fees}U\n当前纸盘现金 ${s.cash}U\n时间价值归因仅为估计，非独立收益。`,
        });
      },
      { group: g, pnl, cash: this.state.cash, fees: g.fees },
    );
  }
  async manage() {
    if (this.locked || this.dbFault || !this.state.group) return;
    this.locked = true;
    try {
      const g = this.state.group;
      if (g.status === "UNKNOWN") return;
      if (Date.now() >= g.expiry) {
        if (g.status !== "SETTLEMENT_PENDING")
          await this.mutate(
            "SETTLEMENT_PENDING",
            (s) => (s.group.status = "SETTLEMENT_PENDING"),
          );
        return;
      }
      const computeStart = performance.now(),
        risk = this.valuation();
      this.latency.add("calculation.risk", performance.now() - computeStart);
      this.lastRisk = risk;
      if (g.status === "OPEN") {
        let reason = null;
        if (g.expiry - Date.now() <= 3600000) reason = "ONE_HOUR_BEFORE_EXPIRY";
        else if (risk.valid) {
          if (D(risk.pnl).gte(D(g.entryNet).mul(".50"))) reason = "TAKE_PROFIT";
          else if (D(risk.closeCost).gte(D(g.entryGross).mul(2)))
            reason = "CREDIT_STOP";
          else if (risk.maxShortDelta >= 0.4) reason = "SHORT_DELTA_STOP";
          else if (risk.maintenanceRatio >= 0.5) reason = "MARGIN_STOP";
        }
        if (reason) await this.beginExit(reason);
      }
      if (this.state.group?.status === "UNWINDING") await this.unwind();
    } finally {
      this.locked = false;
    }
  }
  async settle(records) {
    const g = this.state.group;
    if (!g || g.status !== "SETTLEMENT_PENDING" || this.locked) return false;
    const matches = g.positions.map((p) =>
      records.find(
        (r) => r.symbol === p.leg.symbol && Number(r.expiryDate) === g.expiry,
      ),
    );
    if (matches.some((r) => !r || r.realStrikePrice == null)) return false;
    this.locked = true;
    try {
      let delta = D(0),
        totalFees = D(0);
      for (let i = 0; i < g.positions.length; i++) {
        const p = g.positions[i],
          index = D(matches[i].realStrikePrice),
          l = p.leg,
          intrinsic = max(
            l.side === "CALL"
              ? index.minus(l.strikePrice)
              : D(l.strikePrice).minus(index),
            0,
          ).mul(l.unit),
          f = fee(intrinsic, p.quantity, index, l.unit, ".00015");
        delta = delta
          .plus(intrinsic.mul(p.quantity).mul(l.role === "LONG" ? 1 : -1))
          .minus(f);
        totalFees = totalFees.plus(f);
      }
      await this.mutate(
        "SETTLEMENT_CASH",
        (s) => {
          s.cash = str(D(s.cash).plus(delta));
          s.fees = str(D(s.fees).plus(totalFees));
          s.group.fees = str(D(s.group.fees).plus(totalFees));
          s.group.positions = [];
        },
        { records: matches, cashDelta: str(delta), fees: str(totalFees) },
      );
      await this.finish("GROUP_SETTLED");
      return true;
    } finally {
      this.locked = false;
    }
  }
}
