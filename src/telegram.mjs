import https from "node:https";
import { randomUUID } from "node:crypto";
import { D, str } from "./money.mjs";
export class Telegram {
  constructor(config, engine) {
    this.config = config;
    this.engine = engine;
    this.paper = engine.paper;
    this.running = false;
    this.error = null;
    this.pollTimer = null;
    this.sendTimer = null;
    this.agent = new https.Agent({ keepAlive: true, maxSockets: 3 });
  }
  call(method, payload) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(payload);
      const req = https.request(
        {
          hostname: "api.telegram.org",
          path: "/bot" + this.config.telegramToken + "/" + method,
          method: "POST",
          agent: this.agent,
          timeout: 35000,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (res) => {
          let raw = "";
          res.on("data", (c) => (raw += c));
          res.on("end", () => {
            try {
              const data = JSON.parse(raw);
              if (!data.ok)
                return reject(
                  Error("TELEGRAM_" + (data.error_code || "API_ERROR")),
                );
              resolve(data.result);
            } catch {
              reject(Error("TELEGRAM_INVALID_RESPONSE"));
            }
          });
        },
      );
      req.on("timeout", () => req.destroy());
      req.on("error", () => reject(Error("TELEGRAM_NETWORK_ERROR")));
      req.end(body);
    });
  }
  async start() {
    if (!this.config.telegramEnabled) return;
    if (!this.config.telegramToken || !this.config.allowedChats.length)
      throw Error("TELEGRAM_CONFIGURATION_MISSING");
    this.running = true;
    await this.call("setMyCommands", {
      commands: [
        ["options", "期权纸盘状态"],
        ["positions", "四腿持仓"],
        ["pnl", "费后盈亏"],
        ["risk", "风险与不开仓原因"],
        ["latency", "延迟统计"],
        ["pause", "仅暂停新开仓"],
        ["resume", "恢复纸盘扫描"],
        ["setpaper", "空仓时设置纸盘本金"],
      ].map(([command, description]) => ({ command, description })),
    });
    this.poll();
    this.sendTimer = setInterval(
      () => this.deliver().catch((e) => (this.error = e.message)),
      1500,
    );
    this.sendTimer.unref();
    this.reportTimer = setInterval(
      () => this.daily().catch((e) => (this.error = e.message)),
      30000,
    );
    this.reportTimer.unref();
  }
  async poll() {
    while (this.running) {
      try {
        const updates = await this.call("getUpdates", {
          offset: this.paper.state.telegramOffset,
          timeout: 25,
          allowed_updates: ["message"],
        });
        for (const update of updates) {
          if (!this.running) break;
          const m = update.message,
            chat = String(m?.chat?.id);
          let response = null;
          if (
            this.config.allowedChats.includes(chat) &&
            Number(m.date) * 1000 >= this.paper.state.createdAt - 1000 &&
            typeof m?.text === "string" &&
            m.text.startsWith("/")
          ) {
            const [cmd, arg] = m.text.trim().split(/\s+/, 2);
            try {
              response = await this.engine.command(
                cmd.slice(1).split("@")[0],
                arg,
              );
            } catch (e) {
              response = "未执行：" + e.message;
            }
          }
          await this.paper.mutate("TELEGRAM_UPDATE", (s) => {
            s.telegramOffset = update.update_id + 1;
            if (response)
              s.outbox.push({ id: randomUUID(), chat, text: response });
          });
        }
      } catch (e) {
        this.error = e.message;
        await new Promise((r) => {
          this.pollTimer = setTimeout(r, 5000);
        });
      }
    }
  }
  async deliver() {
    if (this.sending) return;
    this.sending = true;
    try {
      const item = this.paper.state.outbox[0];
      if (!item) return;
      const targets = item.chat ? [item.chat] : this.config.allowedChats;
      for (const chat of targets) {
        if (item.sent?.includes(chat)) continue;
        for (let i = 0; i < item.text.length; i += 3800)
          await this.call("sendMessage", {
            chat_id: chat,
            text: item.text.slice(i, i + 3800),
          });
        await this.paper.mutate("TELEGRAM_DELIVERED", (s) => {
          const row = s.outbox.find((x) => x.id === item.id);
          if (row) (row.sent ??= []).push(chat);
        });
      }
      await this.paper.mutate(
        "TELEGRAM_OUTBOX_ACK",
        (s) => (s.outbox = s.outbox.filter((x) => x.id !== item.id)),
      );
      this.error = null;
    } finally {
      this.sending = false;
    }
  }
  async daily() {
    const local = new Date(Date.now() + 8 * 3600000),
      day = local.toISOString().slice(0, 10);
    if (
      local.getUTCHours() < 9 ||
      (local.getUTCHours() === 9 && local.getUTCMinutes() < 5) ||
      this.paper.state.lastReport === day
    )
      return;
    const end = Date.parse(day + "T00:00:00+08:00"),
      start = end - 86400000;
    if (this.paper.state.createdAt >= end) {
      await this.paper.mutate(
        "REPORT_PREDATES_LEDGER",
        (s) => (s.lastReport = day),
      );
      return;
    }
    const history = await this.engine.store.history(
      this.paper.state.ledger,
      1000,
    );
    const rows = history.filter((x) => x.at >= start && x.at < end);
    let pnl = D(0),
      fees = D(0),
      theta = 0,
      price = 0,
      vol = 0;
    for (const r of rows) {
      pnl = pnl.plus(r.payload.pnl);
      fees = fees.plus(r.payload.fees);
      const a = r.payload.group?.attribution;
      theta += a?.theta || 0;
      price += a?.price || 0;
      vol += a?.volatility || 0;
    }
    const text = `期权纸盘日报 · ${new Date(start + 8 * 3600000).toISOString().slice(0, 10)} 北京时间\n账本 ${this.paper.state.ledger.slice(0, 8)}；初始 ${this.paper.state.initial}U\n关闭 ${rows.length} 组（含失败建仓）\n实际纸盘费后盈亏 ${str(pnl)}U；费用 ${str(fees)}U\n时间价值归因估计 ${theta.toFixed(4)}U\n价格影响估计 ${price.toFixed(4)}U；波动影响估计 ${vol.toFixed(4)}U\n残差含价差/滑点/高阶项，不能当作时间收益。\n只统计本账本关闭事件；空仓零笔属真实查询结果。`;
    await this.paper.mutate(
      "DAILY_REPORT_QUEUED",
      (s) => {
        s.lastReport = day;
        s.outbox.push({ id: randomUUID(), text });
      },
      {
        start,
        end,
        ledger: this.paper.state.ledger,
        count: rows.length,
        pnl: str(pnl),
      },
    );
  }
  stop() {
    this.running = false;
    clearInterval(this.sendTimer);
    clearInterval(this.reportTimer);
    clearTimeout(this.pollTimer);
    this.agent.destroy();
  }
}
