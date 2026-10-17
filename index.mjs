import { config } from "./src/config.mjs";
import { Store, Latencies } from "./src/store.mjs";
import { ReadOnlyApi } from "./src/network.mjs";
import { Market } from "./src/market.mjs";
import { Paper } from "./src/paper.mjs";
import { Engine } from "./src/engine.mjs";
import { Telegram } from "./src/telegram.mjs";
import { serve } from "./src/http.mjs";
const c = config(),
  latency = new Latencies(),
  store = new Store(c.mysql, latency);
const state = await store.init(c.initialPaused);
const api = new ReadOnlyApi(c, latency),
  market = new Market(api, c, store, latency),
  paper = new Paper(store, state, market, latency),
  engine = new Engine(paper, market, store, latency),
  telegram = new Telegram(c, engine);
const server = await serve(c, engine);
engine.telegram = telegram;
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  engine.stop();
  telegram.stop();
  market.stop();
  server.close();
  const deadline = Date.now() + 8000;
  while ((paper.locked || engine.scanning) && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 50));
  await paper.mutations;
  api.close();
  await store.close();
  process.exit(code);
}
process.on("SIGTERM", () => stop().catch(() => process.exit(1)));
process.on("SIGINT", () => stop().catch(() => process.exit(1)));
const leaseWatch = setInterval(() => {
  if (store.leaseLost) stop(1).catch(() => process.exit(1));
}, 10000);
leaseWatch.unref();
process.on("unhandledRejection", () => {
  console.error("UNHANDLED_REJECTION_FAIL_CLOSED");
  stop(1).catch(() => process.exit(1));
});
try {
  await paper.recover();
  await market.start();
  engine.start();
  await telegram.start();
  if (c.telegramEnabled && !paper.state.deploymentAnnounced)
    await paper.mutate("DEPLOYMENT_ANNOUNCED", (s) => {
      s.deploymentAnnounced = true;
      s.outbox.push({
        id: "options-theta-deployed",
        text: "ETH 时间价值机器人已上线：100U 独立纸盘，有保护腿铁鹰。旧预测策略已停仓保留历史。本系统没有实盘接口。\n使用 /options 查看状态；/pause 只停止新开仓；/setpaper 金额 需空仓。\n到期前2–8小时筛选，其他时段采集行情，不强行开单。",
      });
    });
  await store.diagnostic("SERVICE_STARTED", {
    version: c.policy.version,
    mode: "PAPER_ONLY",
    ledger: paper.state.ledger,
  });
  console.log("OPTIONS_THETA_READY PAPER_ONLY");
} catch (e) {
  engine.phase = "FAILED_CLOSED";
  engine.error = e.message;
  console.error("STARTUP_FAILED " + e.message);
  await stop(1);
}
