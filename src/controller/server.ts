import express, { type Request, type Response } from "express";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { AdminAuth, type Session } from "./auth.js";
import { ConfigStore, readJson } from "./store.js";
import { Vault } from "./vault.js";
import { Runtime } from "./runtime.js";
import { Cloudflare } from "./cloudflare.js";
import { redact, redactText } from "../lib/redaction.js";
import { McpUpstreamManager } from "../lib/mcp-upstream-manager.js";
import { createAdminRouter } from "../admin/routes.js";
import { dispatchRouter } from "./ipc.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { guardAsyncRoutes } from "../lib/async-routes.js";
import { cloudflaredInfo } from "./binary.js";
import { WorkspaceManager } from "./workspaces.js";
import { loadUpstreamConfig, saveUpstreamConfig } from "../lib/mcp-upstream-config.js";

export interface ControllerOptions { config: ConfigStore; auth: AdminAuth; vault: Vault; runtime: Runtime; cloudflare: Cloudflare; port: number; workspaces?: WorkspaceManager; onExit?: () => void }
export async function createController(options: ControllerOptions) {
  const { config, auth, vault, runtime, cloudflare, port, workspaces } = options;
  const app = guardAsyncRoutes(express());
  const origin = `http://127.0.0.1:${port}`;
  const clients = new Set<{ res: Response; session: Session }>();
  const logs: any[] = [];
  const operations = new Map<string, any>();
  let sequence = 0, setupBusy = false, configQueue: Promise<unknown> = Promise.resolve();
  const emit = (type: string, data: unknown) => {
    const serialized = JSON.stringify(redact(data));
    for (const client of clients) {
      if (!auth.valid(client.session)) { client.res.end(); clients.delete(client); }
      else client.res.write(`event: ${type}\ndata: ${serialized}\n\n`);
    }
  };
  const addLog = (entry: any) => { logs.push(redact(entry)); if (logs.length > 1000) logs.shift(); emit("log", entry); };
  const events = workspaces || runtime;
  events.on("log", addLog); events.on("status", value => emit("status", value));
  events.on("activity", value => addLog({ time: value.time, source: "activity", workspaceId: value.workspaceId, message: JSON.stringify(value) }));
  const job = (res: Response, task: () => Promise<unknown>) => {
    const id = String(++sequence);
    const operation: any = { id, state: "running", started: new Date().toISOString() };
    if (operations.size >= 100) operations.delete(operations.keys().next().value!);
    operations.set(id, operation); res.status(202).json({ ok: true, operationId: id });
    void Promise.resolve().then(task).then(result => { Object.assign(operation, { state: "complete", result: redact(result) }); }, error => {
      Object.assign(operation, { state: "error", code: error.code || "OPERATION_FAILED", error: redactText(error.message || String(error)), retryAfter: error.retryAfter });
      addLog({ time: new Date().toISOString(), source: "controller", message: operation.error });
    }).finally(() => { operation.finished = new Date().toISOString(); emit("operation", operation); });
  };
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (req.headers.host !== `127.0.0.1:${port}` || !["127.0.0.1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress || "")) { res.status(403).json({ code: "LOCAL_ONLY", error: "Admin chỉ dùng tại 127.0.0.1" }); return; }
    if (req.headers.origin && req.headers.origin !== origin || !["GET", "HEAD"].includes(req.method) && req.headers.origin !== origin) { res.status(403).json({ code: "ORIGIN_REJECTED", error: "Origin không hợp lệ" }); return; }
    next();
  });
  app.use(express.json({ limit: "5mb" }));
  app.get("/controller-health", (_req, res) => res.json({ name: "chatgpt-local-controller", status: "ok" }));
  app.use("/ui", express.static(path.join(config.root, "public", "controller")));
  app.get("/", (_req, res) => res.redirect("/ui/"));
  app.get("/api/auth/session", (req, res) => {
    const session = auth.session(req);
    res.json({ setupRequired: !auth.credential, authenticated: !!session, csrf: session?.csrf });
  });
  app.post("/api/auth/setup", async (req, res) => {
    const nonce = typeof req.body?.nonce === "string" ? req.body.nonce : "";
    if (auth.credential || setupBusy || nonce.length !== auth.bootstrap.length || !timingSafeEqual(Buffer.from(nonce), Buffer.from(auth.bootstrap))) { res.status(403).json({ code: "BOOTSTRAP_REJECTED", error: "Mở panel bằng launcher để tạo mật khẩu lần đầu" }); return; }
    setupBusy = true;
    try { await auth.setPassword(req.body.password); const session = await auth.login(req.body.password); auth.cookie(res, session); res.json({ ok: true, csrf: session.csrf }); }
    finally { setupBusy = false; }
  });
  app.post("/api/auth/login", async (req, res) => { const session = await auth.login(req.body?.password); auth.cookie(res, session); res.json({ ok: true, csrf: session.csrf }); });
  // OAuth redirects cannot carry an admin cookie/CSRF header. The child verifies the one-use OAuth state.
  app.get("/oauth/callback/:id", async (req, res) => {
    try {
      if (typeof req.query.code !== "string" || typeof req.query.state !== "string") throw new Error("OAuth callback thiếu code/state");
      const result = await runtime.rpc("POST", "/internal/oauth/finish", { id: req.params.id, code: req.query.code, state: req.query.state });
      res.status(result.status).type("text").send(result.status === 200 ? "OAuth đã kết nối. Có thể đóng tab." : redactText(JSON.stringify(result.data)));
    } catch (error) { res.status(400).type("text").send(redactText((error as Error).message)); }
  });
  app.get("/workspaces/:workspaceId/oauth/callback/:id", async (req, res) => {
    try {
      if (!workspaces || typeof req.query.code !== "string" || typeof req.query.state !== "string") throw new Error("OAuth callback thiếu workspace/code/state");
      const result = await workspaces.runtime(String(req.params.workspaceId)).rpc("POST", "/internal/oauth/finish", { id: req.params.id, code: req.query.code, state: req.query.state });
      res.status(result.status).type("text").send(result.status === 200 ? "OAuth đã kết nối. Có thể đóng tab." : redactText(JSON.stringify(result.data)));
    } catch (error) { res.status(400).type("text").send(redactText((error as Error).message)); }
  });
  app.use((req, res, next) => {
    const session = auth.session(req);
    if (!session) { res.status(401).json({ code: "AUTH_REQUIRED", error: "Đăng nhập để quản lý" }); return; }
    res.locals.session = session;
    if (!["GET", "HEAD"].includes(req.method) && req.headers["x-csrf-token"] !== session.csrf) { res.status(403).json({ code: "CSRF_REJECTED", error: "CSRF token không hợp lệ" }); return; }
    next();
  });
  const sensitive = (res: Response) => auth.requireRecent(res.locals.session);
  app.get("/api/workspaces", async (_req, res) => res.json({ workspaces: workspaces?.list() || [], gatewayPort: +((await config.values()).PORT || 3000), hostname: (await cloudflare.current())?.hostname }));
  app.post("/api/workspaces", async (req, res) => {
    if (!workspaces) throw new Error("Mở ứng dụng bằng launcher để quản lý nhiều workspace");
    res.status(201).json({ workspace: await workspaces.create(req.body) });
  });
  app.put("/api/workspaces/:id", async (req, res) => {
    if (!workspaces) throw new Error("Workspace manager chưa chạy");
    res.json({ workspace: await workspaces.update(String(req.params.id), req.body) });
  });
  app.post("/api/workspaces/:id/lifecycle", (req, res) => {
    if (!workspaces || !["start", "stop", "restart"].includes(req.body?.action)) throw new Error("Thao tác workspace không hợp lệ");
    const selected = workspaces.runtime(String(req.params.id)); job(res, () => selected.request("mcp", req.body.action));
  });
  app.get("/api/workspaces/:id/connection", async (req, res) => {
    if (!workspaces) throw new Error("Workspace manager chưa chạy");
    const id = String(req.params.id), workspace = workspaces.workspace(id), reveal = req.query.reveal === "1";
    if (reveal) sensitive(res);
    const cf = await cloudflare.current(), token = workspaces.token(id);
    res.json({ workspace, serverUrl: cf?.complete ? `https://${cf.hostname}/mcp/${reveal ? token : "[hidden]"}` : null, localUrl: `http://127.0.0.1:${(await config.values()).PORT || 3000}/mcp/${reveal ? token : "[hidden]"}`, auth: "No authentication" });
  });
  app.get("/api/workspaces/:id/upstream", async (req, res) => {
    if (!workspaces) throw new Error("Workspace manager chưa chạy");
    const id = String(req.params.id); workspaces.workspace(id); const value = await loadUpstreamConfig(path.join(workspaces.directory(id), "mcp-upstream.json"));
    if (req.query.reveal === "1") sensitive(res);
    res.json({ config: req.query.reveal === "1" ? value : redact(value) });
  });
  app.put("/api/workspaces/:id/upstream", async (req, res) => {
    sensitive(res);
    if (!workspaces) throw new Error("Workspace manager chưa chạy");
    const id = String(req.params.id); workspaces.workspace(id);
    if (JSON.stringify(req.body).includes("[hidden]")) throw new Error("Xem cấu hình đầy đủ trước khi sửa");
    const selected = workspaces.runtime(id);
    if (selected.snapshot().mcp.state === "running") { const result = await selected.rpc("PUT", "/api/upstream", req.body); res.status(result.status).json(redact(result.data)); }
    else { await saveUpstreamConfig(req.body.config, path.join(workspaces.directory(id), "mcp-upstream.json")); res.json({ ok: true }); }
  });
  app.post("/api/workspaces/:id/upstream/:serverId/test", (req, res) => {
    if (!workspaces) throw new Error("Workspace manager chưa chạy");
    const selected = workspaces.runtime(String(req.params.id));
    job(res, async () => {
      const result = await selected.rpc("POST", `/api/upstream/${encodeURIComponent(String(req.params.serverId))}/test`, {});
      if (result.status >= 400) throw new Error(JSON.stringify(redact(result.data)));
      if (req.params.serverId === "blender") {
        const socket = await workspaces.blenderSocket(String(req.params.id));
        return { bridge: result.data, addonSocket: socket, guidance: socket.reachable ? "Cổng add-on đang nhận kết nối TCP." : "Mở Blender và bật server của add-on; kiểm tra BLENDER_HOST/BLENDER_PORT." };
      }
      return result.data;
    });
  });
  app.post("/api/auth/logout", (_req, res) => { auth.logout(res.locals.session); auth.cookie(res); res.json({ ok: true }); });
  app.post("/api/auth/reauth", async (req, res) => { await auth.reauthenticate(res.locals.session, req.body?.password); res.json({ ok: true }); });
  app.post("/api/auth/password", async (req, res) => { await auth.reauthenticate(res.locals.session, req.body?.currentPassword); await auth.setPassword(req.body?.password); auth.cookie(res); res.json({ ok: true }); });
  app.get("/api/status", async (_req, res) => {
    const values = await config.values();
    const active = runtime.activeConfig;
    const expected = workspaces ? await runtime.config.values() : values;
    res.json({ ...redact(workspaces?.snapshot() || runtime.snapshot()), cloudflare: await cloudflare.current(), configPending: !!(workspaces && workspaces.gatewayPort !== +values.PORT) || (active ? Object.keys(expected).some(k => expected[k] !== active[k]) || Object.keys(active).some(k => !(k in expected)) : false), autoStart: values.CONTROLLER_AUTOSTART === "true", adminUrl: `${origin}/ui/` });
  });
  app.post("/api/lifecycle", (req, res) => {
    const { target, action } = req.body || {};
    if (!["all", "mcp", "tunnel"].includes(target) || !["start", "stop", "restart"].includes(action)) { res.status(400).json({ error: "Thao tác không hợp lệ" }); return; }
    job(res, () => workspaces ? workspaces.lifecycle(target, action) : runtime.request(target, action));
  });
  app.post("/api/exit", (_req, res) => { res.json({ ok: true }); void (workspaces ? workspaces.close() : runtime.close()).then(() => options.onExit?.()); });
  app.get("/api/operations/:id", (req, res) => { const value = operations.get(req.params.id); res.status(value ? 200 : 404).json(value || { error: "Operation không tồn tại" }); });
  app.get("/api/events", (_req, res) => {
    res.setHeader("Content-Type", "text/event-stream"); res.setHeader("Connection", "keep-alive"); res.flushHeaders();
    const client = { res, session: res.locals.session as Session }; clients.add(client);
    res.write("event: ready\ndata: {}\n\n");
    const heartbeat = setInterval(() => { if (!auth.valid(client.session)) res.end(); else res.write(": keepalive\n\n"); }, 15000);
    res.on("close", () => { clearInterval(heartbeat); clients.delete(client); });
  });
  app.get("/api/logs", (_req, res) => res.json({ entries: logs }));
  app.get("/api/logs/export", (_req, res) => { res.attachment("controller-logs.json").json(redact(logs)); });
  app.get("/api/config/env", async (req, res) => {
    const values = await config.values(); const reveal = req.query.reveal === "1";
    if (reveal) sensitive(res);
    res.json({ ok: true, values: reveal ? values : redact(values), active: reveal ? runtime.activeConfig : redact(runtime.activeConfig), vault: reveal ? vault.all() : redact(vault.all()) });
  });
  app.put("/api/config/env", async (req, res) => {
    const patch = req.body?.values;
    if (!patch || Object.values(patch).some(v => v === "[hidden]")) throw new Error("Chỉ gửi các config thay đổi; không lưu giá trị đã che");
    if (workspaces && ["PORT", "ADMIN_PORT", "CLOUDFLARED_METRICS_PORT"].some(key => patch[key] && workspaces.list().some(w => w.port === +patch[key]))) throw new Error("Cổng này đã được dành cho một workspace");
    if (workspaces && patch.MCP_TOKEN && workspaces.list().some(w => w.id !== "default" && workspaces.token(w.id, true) === patch.MCP_TOKEN)) throw new Error("Token này đã thuộc workspace khác");
    if (Object.keys(patch).some(k => /TOKEN|KEY|SECRET|PASSWORD/.test(k))) sensitive(res);
    const next = configQueue.catch(() => {}).then(() => config.save(patch)); configQueue = next;
    await next; await workspaces?.refreshDefaults(); res.json({ ok: true, restartRequired: true });
  });
  app.get("/api/cloudflare", async (_req, res) => res.json({ current: await cloudflare.current(), preview: await readJson(path.join(config.stateDir, "cloudflare-plan.json"), null), tokenConfigured: !!vault.get("apiToken") }));
  app.get("/api/cloudflare/binary", async (_req, res) => res.json(await cloudflaredInfo(config.root, (await config.values()).CLOUDFLARED_PATH)));
  app.post("/api/cloudflare/connect", async (req, res) => res.json({ zones: await cloudflare.connect(req.body?.token) }));
  app.get("/api/cloudflare/zones", async (_req, res) => res.json({ zones: await cloudflare.zones() }));
  app.get("/api/cloudflare/tunnels", async (req, res) => res.json({ tunnels: await cloudflare.tunnels(String(req.query.accountId || "")) }));
  app.post("/api/cloudflare/preview", async (req, res) => res.json({ preview: await cloudflare.preview(req.body) }));
  app.post("/api/cloudflare/apply", (req, res) => job(res, () => cloudflare.apply(req.body?.planId)));
  app.post("/api/cloudflare/install", (_req, res) => {
    const tunnel = workspaces?.tunnel || runtime;
    if (! ["stopped", "error"].includes(tunnel.snapshot().tunnel.state)) { res.status(409).json({ error: "Dừng tunnel trước khi cài/cập nhật" }); return; }
    job(res, () => cloudflare.install(() => ["stopped", "error"].includes(tunnel.snapshot().tunnel.state) && !tunnel.snapshot().tunnel.pid));
  });
  app.get("/api/gpt", async (req, res) => {
    const current = await cloudflare.current();
    const saved = await config.values(); const running = runtime.activeConfig;
    const reveal = req.query.reveal === "1"; if (reveal) sensitive(res);
    const url = (values: Record<string, string> | null) => current?.complete && values ? `https://${current.hostname}/mcp/${reveal ? values.MCP_TOKEN : "[hidden]"}` : null;
    res.json({ serverUrl: url(running || saved), savedUrl: url(saved), activeUrl: url(running), auth: "No authentication", connection: "Server URL", localHealth: `http://127.0.0.1:${saved.PORT || 3000}/health`, adminUrl: `${origin}/ui/`, cloudflareDashboard: "https://one.dash.cloudflare.com/", dnsDashboard: current ? `https://dash.cloudflare.com/${current.accountId}/${current.zoneName}/dns/records` : null, prompt: "Gọi agent_status rồi project_context trước khi làm việc với dự án." });
  });
  app.post("/api/gpt/probe", (_req, res) => job(res, async () => {
    const current = await cloudflare.current(); const active = runtime.activeConfig;
    if (!current?.complete || !active) throw new Error("Setup Cloudflare và khởi chạy MCP trước");
    const client = new Client({ name: "controller-check", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`https://${current.hostname}/mcp/${active.MCP_TOKEN}`), { requestInit: { signal: AbortSignal.timeout(25000), redirect: "error" } });
    try { await client.connect(transport, { timeout: 25000 }); const listed = await client.listTools({}, { timeout: 25000 }); return { reachable: true, tools: listed.tools.length, checked: new Date().toISOString() }; }
    catch (error) { throw Object.assign(new Error(`Không truy cập được MCP công khai: ${(error as Error).message}. Kiểm tra DNS, tunnel, Cloudflare Access và rate limit; sau đó Refresh app trên GPT.`), { code: "PUBLIC_MCP_UNREACHABLE" }); }
    finally { await transport.terminateSession().catch(() => {}); await client.close().catch(() => {}); }
  }));
  if (workspaces) {
    const defaults = await runtime.config.values();
    for (const key of ["MCP_PLUGINS_CONFIG", "MCP_TOOL_OVERRIDES", "MCP_CODEX_HOOKS_STATE"]) process.env[key] = defaults[key];
  }
  const offline = new McpUpstreamManager(workspaces ? (await runtime.config.values()).MCP_UPSTREAM_CONFIG : undefined); await offline.init();
  const offlineRouter = createAdminRouter(offline, { mcpPort: 3000, pid: process.pid, sessionCount: () => 0 });
  app.use(async (req, res, next) => {
    if (!req.path.startsWith("/api/") && req.path !== "/health") { next(); return; }
    if (req.path === "/api/activity/stream") { res.status(410).json({ error: "Dùng /api/events" }); return; }
    const reveal = req.query.reveal === "1"; if (reveal) sensitive(res);
    if (!["GET", "HEAD"].includes(req.method) && JSON.stringify(req.body ?? {}).includes("[hidden]")) throw new Error("Xem cấu hình đầy đủ sau xác nhận mật khẩu trước khi sửa");
    let result;
    if (runtime.snapshot().mcp.state === "running") result = await runtime.rpc(req.method, req.originalUrl, req.body);
    else {
      if (req.path === "/health" || /\/(test|tools|oauth)(\/|$)/.test(req.path) || req.path === "/api/instructions/preview") throw Object.assign(new Error("Khởi chạy MCP để dùng chức năng này"), { status: 409, code: "MCP_STOPPED" });
      await offline.init(); result = await dispatchRouter(offlineRouter, req.method, req.originalUrl, req.body);
    }
    res.status(result.status).json(reveal ? result.data : redact(result.data));
  });
  app.use((_req, res) => res.status(404).json({ error: "Not found" }));
  app.use((error: any, _req: Request, res: Response, _next: express.NextFunction) => {
    if (error.retryAfter) res.setHeader("Retry-After", error.retryAfter);
    res.status(error.status || 400).json({ ok: false, code: error.code || "REQUEST_FAILED", error: redactText(error.message || String(error)), retryAfter: error.retryAfter });
  });
  return { app, closeEvents() { for (const client of clients) client.res.end(); clients.clear(); } };
}
