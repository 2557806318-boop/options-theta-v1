// Uses a freshly created validation database, NEVER production options_theta.
import assert from "node:assert/strict";
import { Store, Latencies } from "../src/store.mjs";
import { config } from "../src/config.mjs";
const cfg = { ...config().mysql, database: "options_theta_validation" };
const latency = new Latencies(),
  store = new Store(cfg, latency);
let state = await store.init(true);
assert.equal(state.cash, "100");
const competing = new Store(cfg, new Latencies());
await assert.rejects(() => competing.init(true), /SINGLE_ENGINE_LOCK_HELD/);
await competing.close();
let next = structuredClone(state);
next.cash = "99.9";
const event = {
  id: "validation-idempotent",
  kind: "VALIDATION",
  payload: { paperOnly: true },
};
state = await store.commit(state, next, event);
let duplicate = structuredClone(state);
duplicate.cash = "99.8";
state = await store.commit(state, duplicate, event);
assert.equal(state.cash, "99.9");
await assert.rejects(
  () =>
    store.commit({ ...state, version: -1 }, structuredClone(state), {
      id: "cas-failure",
      kind: "VALIDATION",
    }),
  /VERSION_CONFLICT/,
);
assert.equal((await store.load()).cash, "99.9");
latency.add("validation.persist", 12.34);
await store.flush();
store.archiveBytes = 4 * 1024 ** 3;
store.archive({ test: true });
await store.flush();
assert.equal(store.archiveBlocked, true);
await store.close();
const second = new Store(cfg, new Latencies());
const recovered = await second.init(true);
assert.equal(recovered.cash, "99.9");
assert.equal(second.latency.summary()["validation.persist"].p50, 12.34);
await second.pool.execute(
  "INSERT INTO market_archive (at_ms,bytes,data) VALUES (?,?,?)",
  [Date.now() - 31 * 86400000, 3, Buffer.from("old")],
);
await second.retention();
const [[r]] = await second.pool.query(
  "SELECT COUNT(*) AS n FROM market_archive",
);
assert.equal(r.n, 0);
await second.close();
console.log(
  "MYSQL VALIDATION PASS: transaction, idempotency, CAS rollback, restart, persistent latency, quota, retention",
);
