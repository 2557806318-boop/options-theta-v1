import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { selectCandidate, evaluateSize } from "./strategy.mjs";
import { D, str } from "./money.mjs";
import { POLICY } from "./config.mjs";
import { initialState } from "./store.mjs";
export class Engine {
  constructor(paper, market, store, latency) {
    this.paper = paper;
    this.market = market;
    this.store = store;
    this.latency = latency;
    this.phase = "BOOTSTRAP";
    this.reasons = { BOOTSTRAP: 1 };
    this.lastScan = 0;
    this.lastCandidate = null;
    this.timers = [];
    this.scanning = false;
    this.error = null;
    this.lastAudit = 0;
  }
  start() {
    this.phase = "RUNNING";
    this.interval(() => this.scan(), 1000);
    this.interval(() => this.paper.manage(), 100);
    this.interval(() => this.refreshHeldBooks(), 1000);
    this.interval(() => this.archiveRisk(), 10000);
    this.interval(() => this.settle(), 30000);
    this.interval(async () => {
      await this.store.flush();
      if (this.store.archiveBlocked && !this.archiveAlerted) {
        await this.paper.mutate("ARCHIVE_QUOTA_ALERT", (s) =>
          s.outbox.push({
            id: randomUUID(),
            text: "期权普通行情归档已达4GiB配额，暂停普通行情写入；成交审计继续保存。不会删除交易记录。",
          }),
        );
        this.archiveAlerted = true;
      }
    }, 10000);
    this.interval(() => this.store.retention(), 3600000);
  }
  interval(fn, ms) {
    let busy = false;
    const timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        await fn();
      } catch (e) {
        this.error = e.message;
        if (Date.now() - (this.lastErrorAt || 0) > 60000) {
          this.lastErrorAt = Date.now();
          await this.store
            .diagnostic("ERROR", { message: e.message })
            .catch(() => {});
        }
      } finally {
        busy = false;
      }
    }, ms);
    timer.unref();
    this.timers.push(timer);
  }
  context() {
    return {
      contracts: this.market.contracts,
      marks: this.market.marks,
      books: this.market.books,
      index: this.market.indices.get("ETHUSDT")?.price,
      equity: this.paper.state.cash,
      rate: this.market.rate?.taker,
      vol: this.market.vol(),
      now: Date.now(),
      attempts: this.paper.state.attempts,
    };
  }
  async scan() {
    if (this.scanning || this.paper.locked) return;
    this.scanning = true;
    const start = performance.now();
    try {
      this.lastScan = Date.now();
      const state = this.paper.state,
        index = this.market.indices.get("ETHUSDT"),
        rate = this.market.rate;
      let gate = null;
      if (this.paper.dbFault) gate = "DATABASE_UNCERTAIN";
      else if (state.paused) gate = "MANUALLY_PAUSED";
      else if (state.group) gate = "EXISTING_COMBINATION";
      else if (!index || Date.now() - index.receivedAt > 3000)
        gate = "INDEX_STALE";
      else if (!rate || Date.now() - rate.at > 300000)
        gate = "COMMISSION_STALE";
      else if (
        !this.market.connected.market ||
        !this.market.connected.depth ||
        !this.market.connected.spot
      )
        gate = "STREAM_DISCONNECTED";
      if (gate) {
        this.reasons = { [gate]: 1 };
        return;
      }
      const calc = performance.now(),
        result = selectCandidate(this.context());
      this.latency.add("calculation.entry", performance.now() - calc);
      this.reasons = result.reasons;
      this.lastCandidate = result.candidate;
      if (Date.now() - this.lastAudit > 60000) {
        this.lastAudit = Date.now();
        await this.store.diagnostic("CANDIDATE_SCAN", {
          reasons: this.reasons,
          candidate: this.lastCandidate,
          volatility: this.market.vol(),
          ledger: state.ledger,
        });
      }
      if (!result.candidate) return;
      const c = result.candidate;
      await Promise.all(c.legs.map((l) => this.market.snapshot(l.symbol)));
      const context = this.context();
      if (
        !context.index ||
        this.paper.state.paused ||
        this.paper.state.group ||
        c.expiry - context.now < 2 * 3600000
      )
        return;
      const refreshed = {
        ...c,
        legs: c.legs.map((l) => ({
          ...l,
          markPrice: this.market.marks.get(l.symbol)?.markPrice,
        })),
      };
      const sized = evaluateSize(refreshed, c.quantity, context);
      if (!sized.ok) {
        this.reasons = { ["PREFLIGHT_" + sized.reason]: 1 };
        await this.store.diagnostic("PREFLIGHT_REJECTED", {
          candidate: c,
          reason: sized.reason,
        });
        return;
      }
      await this.paper.open({
        ...refreshed,
        ...sized,
        referenceVolatility: context.vol,
        pricingIndex: context.index,
      });
    } finally {
      this.latency.add(
        "calculation.scan_including_io",
        performance.now() - start,
      );
      this.scanning = false;
    }
  }
  async archiveRisk() {
    const g = this.paper.state.group;
    if (!g) {
      this.market.holdings = [];
      return;
    }
    this.market.holdings = g.positions
      .filter((p) => p.leg.expiryDate > Date.now())
      .map((p) => p.leg.symbol);
    const start = performance.now(),
      r = this.paper.valuation();
    this.latency.add("calculation.risk", performance.now() - start);
    if (!r.valid) return;
    const now = Date.now();
    await this.paper.mutate(
      "RISK_SNAPSHOT",
      (s) => {
        const group = s.group;
        if (!group || group.id !== g.id) return;
        const prev = group.lastAttribution;
        if (prev) {
          const dt = Math.min(60, (now - prev.at) / 1000);
          group.attribution.theta += (prev.theta * dt) / 86400;
          group.attribution.price += prev.delta * (r.index - prev.index);
          for (const item of r.items) {
            const prior = prev.items.find((x) => x.symbol === item.symbol);
            if (prior)
              group.attribution.volatility +=
                prior.greek.vegaPerVol *
                prior.multiplier *
                (item.iv - prior.iv);
          }
        }
        group.lastAttribution = {
          at: now,
          theta: r.netTheta,
          delta: r.priceGreek,
          index: r.index,
          items: r.items,
        };
      },
      { risk: r, attributionLabel: "FIRST_ORDER_ESTIMATE_NOT_PROFIT" },
    );
  }
  async settle() {
    const g = this.paper.state.group;
    if (!g || g.status !== "SETTLEMENT_PENDING") return;
    const records = await this.market.api.get(
      "/eapi/v1/exerciseHistory",
      {
        underlying: "ETHUSDT",
        startTime: g.expiry - 1000,
        endTime: g.expiry + 1000,
        limit: 100,
      },
      false,
      undefined,
      3,
    );
    if (!Array.isArray(records)) throw Error("SETTLEMENT_PROTOCOL_DRIFT");
    await this.paper.settle(records);
  }
  async refreshHeldBooks() {
    const group = this.paper.state.group;
    if (!group || group.expiry <= Date.now()) return;
    const positions = [...group.positions],
      now = Date.now();
    const index = this.market.indices.get("ETHUSDT");
    if (
      !index ||
      now - index.receivedAt > 2000 ||
      positions.some(
        (p) =>
          now - (this.market.marks.get(p.leg.symbol)?.receivedAt || 0) > 5000,
      )
    )
      await this.market.refreshReference();
    await Promise.all(
      positions
        .filter((p) => {
          const book = this.market.books.get(p.leg.symbol);
          return !book?.valid || now - book.receivedAt > 1500;
        })
        .map((p) => this.market.snapshot(p.leg.symbol)),
    );
  }
  async command(command, arg) {
    if (command === "pause") {
      await this.paper.mutate("MANUAL_PAUSE", (s) => (s.paused = true));
      return "已暂停新开仓；已有持仓继续风险管理。";
    }
    if (command === "resume") {
      if (this.paper.dbFault) throw Error("DATABASE_UNCERTAIN");
      await this.paper.mutate("MANUAL_RESUME", (s) => (s.paused = false));
      return "100%纸盘模式已恢复寻找机会；不会发送真实订单。";
    }
    if (command === "setpaper") {
      if (this.scanning || this.paper.locked || this.paper.state.group)
        throw Error("必须空仓且无进行中的建仓操作");
      const amount = D(arg);
      if (amount.lt(1) || amount.gt(1000000))
        throw Error("本金范围 1–1000000U");
      await this.paper.mutate(
        "LEDGER_CREATED",
        (s) => {
          const fresh = initialState(s.paused, str(amount));
          const attempts = s.attempts;
          Object.assign(s, {
            ...fresh,
            version: s.version,
            telegramOffset: s.telegramOffset,
            outbox: s.outbox,
            attempts,
          });
        },
        { amount: str(amount) },
      );
      return `已创建全新 ${str(amount)}U 纸盘账本；旧账只读保留。`;
    }
    const state = this.status(),
      p = state.paper;
    if (command === "positions")
      return p.group
        ? JSON.stringify(
            {
              state: p.group.status,
              legs: p.group.positions,
              valuation: p.valuation,
            },
            null,
            2,
          )
        : "当前纸盘空仓。";
    if (command === "pnl")
      return `纸盘初始 ${p.initial}U；现金 ${p.cash}U\n可平仓权益 ${p.valuation.valid ? p.valuation.equity : "数据过期，无法估值"}U\n已实现 ${p.realized}U；累计费用 ${p.fees}U\n完整/失败关闭组合 ${p.closed}；真实账户不计入纸盘。`;
    if (command === "risk")
      return JSON.stringify(
        { limits: state.policy, risk: p.valuation, reasons: state.reasons },
        null,
        2,
      );
    if (command === "latency") return JSON.stringify(state.latency, null, 2);
    return `options-theta-v1 · 仅纸盘\n${p.paused ? "已暂停新开仓" : "运行中"}；ETH 铁鹰，BTC 只观察\n初始 ${p.initial}U；现金 ${p.cash}U\n状态 ${p.group?.status || "FLAT"}\n不开仓原因 ${Object.keys(state.reasons).join(", ") || "筛选中"}\n指令 /options /positions /pnl /risk /latency /pause /resume /setpaper 金额\n无实盘开关。`;
  }
  status() {
    const s = this.paper.state;
    return {
      version: POLICY.version,
      mode: "PAPER_ONLY",
      liveAdapter: false,
      phase: this.phase,
      now: Date.now(),
      lastScan: this.lastScan,
      reasons: this.reasons,
      error: this.error,
      databaseUncertain: this.paper.dbFault,
      telegram: {
        enabled: Boolean(this.telegram?.config.telegramEnabled),
        running: Boolean(this.telegram?.running),
        error: this.telegram?.error || null,
        queued: this.paper.state.outbox.length,
      },
      policy: POLICY,
      paper: {
        ledger: s.ledger,
        createdAt: s.createdAt,
        initial: s.initial,
        cash: s.cash,
        fees: s.fees,
        realized: s.realized,
        closed: s.closed,
        paused: s.paused,
        group: s.group,
        valuation: this.paper.valuation(),
        attempts: s.attempts,
      },
      market: this.market.status(),
      latency: this.latency.summary(),
      archive: {
        bytes: this.store.archiveBytes,
        quota: POLICY.archiveQuotaBytes,
        blocked: this.store.archiveBlocked,
        dropped: this.store.archiveDropped || 0,
      },
      candidate: this.lastCandidate,
      acceptance: {
        minimumDays: 14,
        minimumGroups: 30,
        elapsedDays: (Date.now() - s.createdAt) / 86400000,
        closedGroups: s.completeClosed || 0,
        approved: false,
      },
    };
  }
  stop() {
    this.phase = "STOPPING";
    for (const t of this.timers) clearInterval(t);
  }
}
