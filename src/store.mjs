import mysql from "mysql2/promise";
import { gzipSync, gunzipSync } from "node:zlib";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
export function initialState(paused = false, capital = "100") {
  return {
    version: 0,
    ledger: randomUUID(),
    createdAt: Date.now(),
    initial: capital,
    cash: capital,
    fees: "0",
    realized: "0",
    paused,
    attempts: {},
    group: null,
    closed: 0,
    completeClosed: 0,
    telegramOffset: 0,
    lastReport: "",
    outbox: [],
    lastError: null,
  };
}
export class Latencies {
  constructor() {
    this.rows = [];
    this.pending = [];
  }
  add(name, ms, at = Date.now()) {
    if (!Number.isFinite(ms) || ms < 0) return;
    const row = { name, ms, at };
    this.rows.push(row);
    this.pending.push(row);
    if (this.rows.length > 100000) this.rows.splice(0, 10000);
    if (this.pending.length > 10000) this.pending.splice(0, 1000);
  }
  summary() {
    const grouped = {};
    for (const r of this.rows) {
      if (r.at < Date.now() - 86400000) continue;
      (grouped[r.name] ??= []).push(r);
    }
    const result = {};
    for (const [k, rows] of Object.entries(grouped)) {
      const v = rows.map((x) => x.ms).sort((a, b) => a - b);
      const p = (q) => v[Math.min(v.length - 1, Math.ceil(v.length * q) - 1)];
      result[k] = {
        count: v.length,
        p50: p(0.5),
        p95: p(0.95),
        p99: p(0.99),
        max: v.at(-1),
        from: Math.min(...rows.map((x) => x.at)),
        to: Math.max(...rows.map((x) => x.at)),
        kind: k.startsWith("paper.") ? "SIMULATED_NOT_LIVE" : "MEASURED",
      };
    }
    return result;
  }
}
const parsed = (x) => (typeof x === "string" ? JSON.parse(x) : x);
export class Store {
  constructor(config, latency) {
    this.pool = mysql.createPool({ ...config, enableKeepAlive: true });
    this.latency = latency;
    this.archiveQueue = [];
    this.archiveBytes = 0;
    this.archiveBlocked = false;
    this.flushing = false;
  }
  async init(paused) {
    this.lockConnection = await this.pool.getConnection();
    const [[lease]] = await this.lockConnection.query(
      "SELECT GET_LOCK(?,0) AS acquired",
      [this.pool.pool.config.connectionConfig.database + ":engine"],
    );
    if (Number(lease.acquired) !== 1) {
      this.lockConnection.release();
      this.lockConnection = null;
      throw Error("SINGLE_ENGINE_LOCK_HELD");
    }
    this.lockConnection.on("error", () => {
      this.leaseLost = true;
    });
    const tables = [
      "CREATE TABLE IF NOT EXISTS runtime (id INT PRIMARY KEY,version BIGINT NOT NULL,payload JSON NOT NULL)",
      "CREATE TABLE IF NOT EXISTS ledgers (id VARCHAR(36) PRIMARY KEY,created_at BIGINT NOT NULL,initial_capital DECIMAL(38,18) NOT NULL)",
      "CREATE TABLE IF NOT EXISTS events (id VARCHAR(80) PRIMARY KEY,ledger VARCHAR(36) NOT NULL,group_id VARCHAR(36),kind VARCHAR(40) NOT NULL,at_ms BIGINT NOT NULL,payload JSON NOT NULL,INDEX(ledger,at_ms),INDEX(group_id))",
      "CREATE TABLE IF NOT EXISTS diagnostics (id BIGINT AUTO_INCREMENT PRIMARY KEY,at_ms BIGINT NOT NULL,kind VARCHAR(40) NOT NULL,payload JSON NOT NULL,INDEX(at_ms))",
      "CREATE TABLE IF NOT EXISTS latency (id BIGINT AUTO_INCREMENT PRIMARY KEY,at_ms BIGINT NOT NULL,name VARCHAR(80) NOT NULL,ms DOUBLE NOT NULL,INDEX(at_ms))",
      "CREATE TABLE IF NOT EXISTS latency_batches (id BIGINT AUTO_INCREMENT PRIMARY KEY,at_ms BIGINT NOT NULL,sample_count INT NOT NULL,data MEDIUMBLOB NOT NULL,INDEX(at_ms))",
      "CREATE TABLE IF NOT EXISTS market_archive (id BIGINT AUTO_INCREMENT PRIMARY KEY,at_ms BIGINT NOT NULL,bytes INT NOT NULL,data MEDIUMBLOB NOT NULL,INDEX(at_ms))",
      "CREATE TABLE IF NOT EXISTS contracts (symbol VARCHAR(80) PRIMARY KEY,updated_at BIGINT NOT NULL,payload JSON NOT NULL)",
    ];
    for (const sql of tables) await this.pool.query(sql);
    const s = initialState(paused);
    await this.pool.execute("INSERT IGNORE INTO runtime VALUES (1,0,?)", [
      JSON.stringify(s),
    ]);
    const current = await this.load();
    await this.pool.execute("INSERT IGNORE INTO ledgers VALUES (?,?,?)", [
      current.ledger,
      current.createdAt,
      current.initial,
    ]);
    const [batches] = await this.pool.query(
      "SELECT data FROM latency_batches WHERE at_ms>? ORDER BY id DESC LIMIT 300",
      [Date.now() - 86400000],
    );
    const restored = batches.reverse().flatMap((r) =>
      JSON.parse(gunzipSync(r.data)).map(([at, name, ms]) => ({
        at,
        name,
        ms,
      })),
    );
    const [rows] = await this.pool.query(
      "SELECT at_ms AS at,name,ms FROM latency WHERE at_ms>? ORDER BY id DESC LIMIT 10000",
      [Date.now() - 86400000],
    );
    this.latency.rows = [
      ...rows.reverse().map((r) => ({ ...r, at: Number(r.at) })),
      ...restored,
    ].slice(-100000);
    const [[r]] = await this.pool.query(
      "SELECT COALESCE(SUM(bytes),0) AS total FROM market_archive",
    );
    this.archiveBytes = Number(r.total);
    return current;
  }
  async load() {
    const start = performance.now();
    try {
      const [[r]] = await this.pool.query(
        "SELECT payload FROM runtime WHERE id=1",
      );
      return r ? parsed(r.payload) : null;
    } finally {
      this.latency.add("database.query", performance.now() - start);
    }
  }
  async commit(previous, next, event) {
    if (this.leaseLost) throw Error("DATABASE_ENGINE_LEASE_LOST");
    const start = performance.now(),
      c = await this.pool.getConnection();
    try {
      await c.beginTransaction();
      const [[seen]] = await c.execute("SELECT id FROM events WHERE id=?", [
        event.id,
      ]);
      if (seen) {
        await c.rollback();
        return await this.load();
      }
      next.version = previous.version + 1;
      const [r] = await c.execute(
        "UPDATE runtime SET version=?,payload=? WHERE id=1 AND version=?",
        [next.version, JSON.stringify(next), previous.version],
      );
      if (r.affectedRows !== 1) throw Error("STATE_VERSION_CONFLICT");
      await c.execute("INSERT IGNORE INTO ledgers VALUES (?,?,?)", [
        next.ledger,
        next.createdAt,
        next.initial,
      ]);
      await c.execute("INSERT INTO events VALUES (?,?,?,?,?,?)", [
        event.id,
        next.ledger,
        event.groupId || next.group?.id || null,
        event.kind,
        Date.now(),
        JSON.stringify(event.payload || {}),
      ]);
      await c.commit();
      return next;
    } catch (e) {
      await c.rollback().catch(() => {});
      throw e;
    } finally {
      c.release();
      this.latency.add("database.commit", performance.now() - start);
    }
  }
  async diagnostic(kind, payload) {
    await this.pool.execute(
      "INSERT INTO diagnostics (at_ms,kind,payload) VALUES (?,?,?)",
      [Date.now(), kind, JSON.stringify(payload)],
    );
  }
  async saveContracts(rows) {
    for (const row of rows)
      await this.pool.execute("REPLACE INTO contracts VALUES (?,?,?)", [
        row.symbol,
        Date.now(),
        JSON.stringify(row),
      ]);
  }
  archive(payload) {
    if (this.archiveBlocked) return;
    if (this.archiveQueue.length < 30)
      this.archiveQueue.push({ at: Date.now(), payload });
    else this.archiveDropped = (this.archiveDropped || 0) + 1;
  }
  async flush() {
    if (this.flushing) return;
    this.flushing = true;
    try {
      if (this.lockConnection) {
        if (this.leaseLost) throw Error("DATABASE_ENGINE_LEASE_LOST");
        await this.lockConnection.query("SELECT 1");
      }
      const samples = this.latency.pending.splice(0, 10000);
      if (samples.length)
        try {
          const data = gzipSync(
            JSON.stringify(samples.map((r) => [r.at, r.name, r.ms])),
          );
          await this.pool.execute(
            "INSERT INTO latency_batches (at_ms,sample_count,data) VALUES (?,?,?)",
            [Date.now(), samples.length, data],
          );
        } catch (e) {
          this.latency.pending.unshift(...samples);
          throw e;
        }
      const queue = this.archiveQueue.splice(0, 30);
      if (queue.length) {
        const data = gzipSync(JSON.stringify(queue));
        if (this.archiveBytes + data.length <= 4 * 1024 ** 3) {
          const start = performance.now();
          await this.pool.execute(
            "INSERT INTO market_archive (at_ms,bytes,data) VALUES (?,?,?)",
            [Date.now(), data.length, data],
          );
          this.archiveBytes += data.length;
          this.latency.add("database.market_batch", performance.now() - start);
        } else this.archiveBlocked = true;
      }
    } finally {
      this.flushing = false;
    }
  }
  async retention() {
    await this.pool.execute(
      "DELETE FROM market_archive WHERE at_ms<? LIMIT 5000",
      [Date.now() - 30 * 86400000],
    );
    const [[r]] = await this.pool.query(
      "SELECT COALESCE(SUM(bytes),0) AS total FROM market_archive",
    );
    this.archiveBytes = Number(r.total);
    this.archiveBlocked = this.archiveBytes >= 4 * 1024 ** 3;
  }
  async history(ledger, limit = 100) {
    const start = performance.now();
    try {
      const [rows] = await this.pool.execute(
        "SELECT kind,at_ms AS at,payload FROM events WHERE ledger=? AND kind IN ('GROUP_CLOSED','GROUP_SETTLED') ORDER BY at_ms DESC LIMIT " +
          Math.min(1000, Math.max(1, limit)),
        [ledger],
      );
      return rows.map((r) => ({
        ...r,
        at: Number(r.at),
        payload: parsed(r.payload),
      }));
    } finally {
      this.latency.add("database.history_query", performance.now() - start);
    }
  }
  async close() {
    await this.flush();
    if (this.lockConnection) {
      await this.lockConnection
        .query("SELECT RELEASE_LOCK(?)", [
          this.pool.pool.config.connectionConfig.database + ":engine",
        ])
        .catch(() => {});
      this.lockConnection.release();
    }
    await this.pool.end();
  }
}
export class MemoryStore {
  constructor(state = initialState()) {
    this.state = structuredClone(state);
    this.events = [];
    this.fail = false;
  }
  async load() {
    return structuredClone(this.state);
  }
  async commit(previous, next, event) {
    if (this.fail) throw Error("INJECTED_DB_FAILURE");
    if (this.events.some((x) => x.id === event.id)) return this.load();
    if (previous.version !== this.state.version)
      throw Error("STATE_VERSION_CONFLICT");
    next.version = previous.version + 1;
    this.state = structuredClone(next);
    this.events.push(event);
    return this.load();
  }
}
