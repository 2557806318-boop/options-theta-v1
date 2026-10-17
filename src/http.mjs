import http from "node:http";
import { readFile } from "node:fs/promises";
export async function serve(config, engine) {
  const page = await readFile(new URL("../public/index.html", import.meta.url));
  const server = http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
    );
    try {
      if (req.method !== "GET") {
        res.writeHead(405);
        return res.end("READ_ONLY");
      }
      if (req.url === "/") {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        return res.end(page);
      }
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      let data;
      if (req.url === "/api/status") data = engine.status();
      else if (req.url === "/api/latency") data = engine.latency.summary();
      else if (req.url === "/api/history")
        data = await engine.store.history(engine.paper.state.ledger);
      else {
        res.writeHead(404);
        return res.end("{}");
      }
      res.end(JSON.stringify(data));
    } catch {
      res.writeHead(503);
      res.end(JSON.stringify({ error: "STATUS_UNAVAILABLE" }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, resolve);
  });
  return server;
}
