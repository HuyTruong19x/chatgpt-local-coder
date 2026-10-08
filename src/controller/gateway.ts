import http, { type IncomingHttpHeaders } from "node:http";

export interface GatewayTarget { id: string; token: string; port: number; running: boolean }
const hop = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
function headers(source: IncomingHttpHeaders): IncomingHttpHeaders {
  const excluded = new Set([...hop, ...String(source.connection || "").toLowerCase().split(",").map(s => s.trim())]);
  return Object.fromEntries(Object.entries(source).filter(([name]) => !excluded.has(name)));
}

/** Stream MCP traffic without redirects or JSON/SSE buffering. Only registered tokens route. */
export class TokenGateway {
  private server?: http.Server;
  private streams = new Set<http.ClientRequest>();
  private owners = new Map<string, { id: string; touched: number }>();
  constructor(private targets: () => GatewayTarget[]) {}
  async listen(port: number): Promise<void> {
    if (this.server) return;
    const server = http.createServer((req, res) => {
      const reply = (status: number, error: string) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify({ error })); };
      if (req.headers.origin) { reply(403, "Browser origins are not allowed"); return; }
      if (req.url === "/health" && req.method === "GET") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ status: "ok", name: "codex-mcp-server" })); return; }
      const match = /^\/mcp\/([A-Za-z0-9_-]{24,})$/.exec(req.url || "");
      const target = match && this.targets().find(t => t.token === match[1]);
      if (!target) { reply(404, "Not found"); return; }
      if (!["GET", "POST", "DELETE"].includes(req.method || "")) { reply(405, "Method not allowed"); return; }
      if (!target.running) { reply(503, "Workspace is stopped"); return; }
      const sid = req.headers["mcp-session-id"];
      if (Array.isArray(sid)) { reply(400, "Invalid session header"); return; }
      const owner = typeof sid === "string" ? this.owners.get(sid) : undefined;
      if (owner && owner.id !== target.id) { reply(404, "Session not found"); return; }
      if (owner) owner.touched = Date.now();
      const requestHeaders = headers(req.headers);
      delete requestHeaders.cookie; delete requestHeaders.authorization; delete requestHeaders["x-csrf-token"];
      requestHeaders.host = `127.0.0.1:${target.port}`;
      const proxy = http.request({ hostname: "127.0.0.1", port: target.port, path: req.url, method: req.method, headers: requestHeaders }, upstream => {
        clearTimeout(timer);
        const assigned = upstream.headers["mcp-session-id"];
        if (typeof assigned === "string") {
          const prior = this.owners.get(assigned);
          if (prior && prior.id !== target.id) { upstream.destroy(); reply(502, "Invalid upstream session"); return; }
          this.owners.set(assigned, { id: target.id, touched: Date.now() });
          if (this.owners.size > 10000) {
            for (const [id, value] of this.owners) if (value.touched < Date.now() - 86400000) this.owners.delete(id);
            if (this.owners.size > 10000) this.owners.delete(this.owners.keys().next().value!);
          }
        }
        res.writeHead(upstream.statusCode || 502, headers(upstream.headers));
        upstream.on("error", () => res.destroy());
        upstream.pipe(res);
        res.on("close", () => upstream.destroy());
      });
      this.streams.add(proxy);
      const timer = setTimeout(() => proxy.destroy(new Error("Upstream response timeout")), 30000); timer.unref();
      proxy.once("close", () => { clearTimeout(timer); this.streams.delete(proxy); });
      proxy.on("error", () => { if (!res.headersSent && !res.destroyed) reply(502, "Workspace is unavailable"); else res.destroy(); });
      req.on("aborted", () => proxy.destroy());
      res.on("close", () => proxy.destroy());
      let bytes = 0;
      req.on("data", chunk => { bytes += chunk.length; if (bytes > 50 * 1024 * 1024) { req.unpipe(proxy); if (!res.headersSent) reply(413, "Request too large"); proxy.destroy(); } });
      req.pipe(proxy);
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
    this.server = server;
  }
  async close(): Promise<void> {
    for (const stream of this.streams) stream.destroy(); this.streams.clear(); this.owners.clear();
    const server = this.server; this.server = undefined;
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }
}
