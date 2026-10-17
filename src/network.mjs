import https from "node:https";
import { createHmac } from "node:crypto";
import { performance } from "node:perf_hooks";
const ALLOWED = new Set([
  "/eapi/v1/time",
  "/eapi/v1/exchangeInfo",
  "/eapi/v1/index",
  "/eapi/v1/mark",
  "/eapi/v1/depth",
  "/eapi/v1/marginAccount",
  "/eapi/v1/commission",
  "/eapi/v1/exerciseHistory",
]);
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export class ReadOnlyApi {
  constructor(config, latency) {
    this.config = config;
    this.latency = latency;
    this.agent = new https.Agent({
      keepAlive: true,
      maxSockets: 6,
      scheduling: "lifo",
    });
    this.used = 0;
    this.window = 0;
    this.limit = 2400;
    this.offset = 0;
    this.blockedUntil = 0;
  }
  async get(
    path,
    params = {},
    signed = false,
    host = "eapi.binance.com",
    weight = 5,
  ) {
    if (
      host === "eapi.binance.com"
        ? !ALLOWED.has(path)
        : !(host === "api.binance.com" && path === "/api/v3/klines")
    )
      throw Error("READ_ONLY_ENDPOINT_DENIED");
    const now = Date.now();
    if (now < this.blockedUntil) throw Error("REST_RATE_LIMIT_COOLDOWN");
    const minute = Math.floor((now + this.offset) / 60000);
    if (minute !== this.window) {
      this.window = minute;
      this.used = 0;
    }
    if (this.used + weight > this.limit * 0.7)
      throw Error("REST_30_PERCENT_RESERVE");
    this.used += weight;
    const query = new URLSearchParams(params);
    if (signed) {
      if (!this.config.apiKey || !this.config.apiSecret)
        throw Error("API_CREDENTIALS_MISSING");
      query.set("timestamp", String(Math.trunc(Date.now() + this.offset)));
      query.set("recvWindow", "5000");
      query.set(
        "signature",
        createHmac("sha256", this.config.apiSecret)
          .update(query.toString())
          .digest("hex"),
      );
    }
    const start = performance.now();
    try {
      return await new Promise((resolve, reject) => {
        const req = https.request(
          {
            host,
            path: path + "?" + query,
            method: "GET",
            agent: this.agent,
            timeout: 5000,
            headers: signed ? { "X-MBX-APIKEY": this.config.apiKey } : {},
          },
          (res) => {
            let data = "";
            res.on("data", (c) => {
              data += c;
              if (data.length > 12e6) {
                req.destroy();
                reject(Error("RESPONSE_TOO_LARGE"));
              }
            });
            res.on("end", () => {
              const used = Number(res.headers["x-mbx-used-weight-1m"]);
              if (Number.isFinite(used)) this.used = Math.max(this.used, used);
              if (res.statusCode === 429 || res.statusCode === 418)
                this.blockedUntil =
                  Date.now() +
                  Math.max(
                    60000,
                    Number(res.headers["retry-after"] || 60) * 1000,
                  );
              if (res.statusCode !== 200) {
                let code = "";
                try {
                  const numeric = JSON.parse(data).code;
                  if (Number.isInteger(numeric)) code = "_CODE_" + numeric;
                } catch {}
                return reject(
                  Error(
                    `REST_${res.statusCode}_${path.split("/").at(-1)}${code}`,
                  ),
                );
              }
              try {
                resolve(JSON.parse(data));
              } catch {
                reject(Error("REST_JSON_INVALID"));
              }
            });
          },
        );
        req.on("timeout", () => req.destroy(Error("REST_TIMEOUT")));
        req.on("error", (e) =>
          reject(
            Error(
              e.code || e.message === "REST_TIMEOUT"
                ? "REST_NETWORK_OR_TIMEOUT"
                : "REST_NETWORK_ERROR",
            ),
          ),
        );
        req.end();
      });
    } finally {
      this.latency.add(
        "rest." + path.split("/").at(-1),
        performance.now() - start,
      );
    }
  }
  async syncTime() {
    let best = null;
    for (let i = 0; i < 3; i++) {
      const start = Date.now(),
        r = await this.get("/eapi/v1/time", {}, false, undefined, 1),
        end = Date.now();
      const sample = {
        rtt: end - start,
        offset: Number(r.serverTime) - (start + end) / 2,
      };
      if (!best || sample.rtt < best.rtt) best = sample;
    }
    this.offset = best.offset;
    this.clockUncertaintyMs = best.rtt / 2;
    this.clockSyncAt = Date.now();
  }
  close() {
    this.agent.destroy();
  }
}
