import test from "node:test";
import assert from "node:assert/strict";
import { Paper } from "../src/paper.mjs";
import { Engine } from "../src/engine.mjs";
import { Telegram } from "../src/telegram.mjs";
import { MemoryStore, Latencies, initialState } from "../src/store.mjs";
function fixture() {
  const store = new MemoryStore(initialState()),
    latency = new Latencies(),
    market = {
      indices: new Map(),
      books: new Map(),
      marks: new Map(),
      status: () => ({}),
      vol: () => ({ ready: false }),
    };
  const paper = new Paper(store, structuredClone(store.state), market, latency),
    engine = new Engine(paper, market, store, latency);
  return { store, paper, engine, latency };
}
test("pause/resume only paper, setpaper creates new ledger and preserves expiry attempts", async () => {
  const { paper, engine } = fixture();
  paper.state.attempts = { 123: 2 };
  await engine.command("pause");
  assert.equal(paper.state.paused, true);
  await engine.command("resume");
  assert.equal(paper.state.paused, false);
  const ledger = paper.state.ledger;
  await engine.command("setpaper", "30");
  assert.notEqual(paper.state.ledger, ledger);
  assert.equal(paper.state.cash, "30");
  assert.equal(paper.state.attempts["123"], 2);
  await paper.mutate("TEST_OPEN", (s) => (s.group = { status: "UNKNOWN" }));
  await assert.rejects(() => engine.command("setpaper", "100"));
});
test("concurrent runtime changes are serialized, not lost", async () => {
  const { paper } = fixture();
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      paper.mutate("TEST", (s) => (s.attempts[i] = i)),
    ),
  );
  assert.equal(Object.keys(paper.state.attempts).length, 20);
  assert.equal(paper.state.version, 20);
});
test("Telegram delivery failure retains durable outbox until successful", async () => {
  const { paper, engine } = fixture();
  await paper.mutate("TEST_MESSAGE", (s) =>
    s.outbox.push({ id: "test", text: "paper test" }),
  );
  const tg = new Telegram({ allowedChats: ["1"] }, engine);
  tg.call = async () => {
    throw Error("INJECTED_SEND_FAILURE");
  };
  await assert.rejects(() => tg.deliver());
  assert.equal(paper.state.outbox.length, 1);
  const calls = [];
  tg.call = async (m, p) => {
    calls.push(p);
    return { message_id: 1 };
  };
  await tg.deliver();
  assert.equal(paper.state.outbox.length, 0);
  assert.equal(calls.length, 1);
  tg.stop();
});
test("latency distinguishes simulated waits, excludes negative source clock error", () => {
  const l = new Latencies();
  for (let i = 1; i <= 100; i++) l.add("paper.leg_simulated_wait", i);
  l.add("rest.depth", -10);
  const s = l.summary();
  assert.equal(s["paper.leg_simulated_wait"].p99, 99);
  assert.equal(s["paper.leg_simulated_wait"].kind, "SIMULATED_NOT_LIVE");
  assert(!s["rest.depth"]);
});
