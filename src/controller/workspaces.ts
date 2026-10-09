import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { ConfigStore, atomicJson, readJson } from "./store.js";
import { Vault } from "./vault.js";
import { Runtime, availablePort } from "./runtime.js";
import { TokenGateway } from "./gateway.js";
import { rememberSecret } from "../lib/redaction.js";
import { loadUpstreamConfig, saveUpstreamConfig, type UpstreamConfigFile } from "../lib/mcp-upstream-config.js";

export interface Workspace { id: string; name: string; path: string; port: number; preset: "coding"; autoStart: boolean }

class WorkspaceConfig extends ConfigStore {
  constructor(private manager: WorkspaceManager, private workspace: Workspace) { super(manager.config.root); }
  override get stateDir() { return this.manager.directory(this.workspace.id); }
  override async values(): Promise<Record<string, string>> {
    const base = await this.manager.config.values(), workspace = this.workspace;
    const token = this.manager.token(workspace.id, true);
    return { ...base, PORT: String(workspace.port), WORKSPACE_PATH: workspace.path, MCP_TOKEN: token,
      WORKSPACE_PATHS: "", EXTRA_WORKSPACE_PATHS: "", ALLOWED_WORKSPACE_PATHS: "", MCP_WORKSPACE_ID: workspace.id,
      MCP_UPSTREAM_CONFIG: path.join(this.stateDir, "mcp-upstream.json"), MCP_OAUTH_STORE: path.join(this.stateDir, "oauth"),
      MCP_OAUTH_CALLBACK_BASE: `http://127.0.0.1:${base.ADMIN_PORT || 3001}/workspaces/${workspace.id}`,
      AUDIT_LOG_PATH: path.join(this.stateDir, "audit.log"), CHECKPOINT_PATH: path.join(this.stateDir, "checkpoints"),
      MCP_SHELL_STATE_DIR: path.join(this.stateDir, "shell"), MCP_PLUGINS_CONFIG: path.join(this.stateDir, "plugins.json"),
      MCP_TOOL_OVERRIDES: path.join(this.stateDir, "tool-overrides.json"), MCP_CODEX_HOOKS_STATE: path.join(this.stateDir, "codex-hooks.json"),
    };
  }
}

export class WorkspaceManager extends EventEmitter {
  readonly runtimes = new Map<string, Runtime>();
  readonly gateway = new TokenGateway(() => this.records.map(w => ({ id: w.id, token: this.token(w.id), port: w.port, running: this.runtime(w.id).snapshot().mcp.state === "running" })));
  readonly tunnel: Runtime;
  private records: Workspace[] = [];
  private ready = false;
  gatewayPort = 0;
  private writes: Promise<unknown> = Promise.resolve();
  private lifecycleVersion = 0;
  constructor(readonly config: ConfigStore, readonly vault: Vault, private entry = path.join(config.root, "dist/index.js")) {
    super(); this.tunnel = new Runtime(config, vault, entry, undefined, undefined, () => this.ready);
    this.tunnel.on("log", value => this.emit("log", value)); this.tunnel.on("status", () => this.emit("status", this.snapshot()));
  }
  directory(id: string) { return path.join(this.config.stateDir, "workspaces", id); }
  private get file() { return path.join(this.config.stateDir, "workspaces.json"); }
  token(id: string, saved = false) { return !saved && this.runtimes.get(id)?.activeConfig?.MCP_TOKEN || (id === "default" ? this.defaultToken : this.vault.get(`workspace_${id}_token`)); }
  private defaultToken = "";
  private attach(workspace: Workspace): void {
    const runtime = new Runtime(new WorkspaceConfig(this, workspace), this.vault, this.entry);
    runtime.on("log", value => this.emit("log", { ...value, workspaceId: workspace.id }));
    runtime.on("activity", value => this.emit("activity", { ...value, workspaceId: workspace.id }));
    runtime.on("status", () => this.emit("status", this.snapshot()));
    this.runtimes.set(workspace.id, runtime);
  }
  async init(): Promise<void> {
    const values = await this.config.values(); this.defaultToken = values.MCP_TOKEN || ""; rememberSecret(this.defaultToken);
    this.records = await readJson<Workspace[]>(this.file, []);
    // Retire the discontinued preset without deleting user project files.
    const retired = this.records.filter(w => String(w.preset) === "blender");
    for (const workspace of retired) {
      if (!/^[a-f0-9-]{36}$/.test(workspace.id)) throw new Error("Workspace cũ có ID không hợp lệ");
      await this.vault.save({ [`workspace_${workspace.id}_token`]: "" });
      await saveUpstreamConfig({ version: 1, servers: [] }, path.join(this.directory(workspace.id), "mcp-upstream.json"));
    }
    if (retired.length) {
      this.records = this.records.filter(w => String(w.preset) !== "blender");
      await atomicJson(this.file, this.records);
    }
    if (!this.records.length) {
      const port = await this.allocate();
      const workspace: Workspace = { id: "default", name: "Workspace hiện tại", path: path.resolve(values.WORKSPACE_PATH || this.config.root), port, preset: "coding", autoStart: values.CONTROLLER_AUTOSTART === "true" };
      await this.prepare(workspace, true); this.records.push(workspace); await atomicJson(this.file, this.records);
    }
    const used = new Set<number>(), ids = new Set<string>(), tokens = new Set<string>();
    for (const workspace of this.records) {
      if (!/^(default|[a-f0-9-]{36})$/.test(workspace.id) || ids.has(workspace.id) || used.has(workspace.port)
        || !Number.isInteger(workspace.port) || workspace.port < 1024 || workspace.port > 65535
        || [+(values.PORT || 3000), +(values.ADMIN_PORT || 3001), +(values.CLOUDFLARED_METRICS_PORT || 20241)].includes(workspace.port)) throw new Error("Workspace registry có ID/cổng xung đột");
      const token = this.token(workspace.id);
      if (!/^[A-Za-z0-9_-]{24,}$/.test(token) || tokens.has(token)) throw new Error("Workspace thiếu token hoặc trùng token; nhập lại vault đúng tài khoản Windows");
      ids.add(workspace.id); used.add(workspace.port); tokens.add(token); rememberSecret(token); this.attach(workspace);
    }
    if (!ids.has("default")) throw new Error("Workspace registry thiếu workspace mặc định");
  }
  private async allocate(): Promise<number> {
    const values = await this.config.values(), reserved = new Set([+(values.PORT || 3000), +(values.ADMIN_PORT || 3001), +(values.CLOUDFLARED_METRICS_PORT || 20241), ...this.records.map(w => w.port)]);
    for (let port = 3010; port < 65535; port++) { if (reserved.has(port)) continue; try { await availablePort(port); return port; } catch {} }
    throw new Error("Không còn cổng local cho workspace");
  }
  private async prepare(workspace: Workspace, migrate = false): Promise<void> {
    const folder = this.directory(workspace.id); await fs.mkdir(folder, { recursive: true });
    for (const name of ["mcp-upstream.json", "plugins.json", "tool-overrides.json", "codex-hooks.json"]) {
      const values = await this.config.values();
      const source = name === "mcp-upstream.json" && values.MCP_UPSTREAM_CONFIG ? path.resolve(this.config.root, values.MCP_UPSTREAM_CONFIG) : path.join(this.config.root, "profiles", name);
      if (migrate) await fs.copyFile(source, path.join(folder, name)).catch(error => { if (error.code !== "ENOENT") throw error; });
    }
    if (!migrate || !(await fs.stat(path.join(folder, "mcp-upstream.json")).catch(() => null))) {
      await saveUpstreamConfig({ version: 1, servers: [] }, path.join(folder, "mcp-upstream.json"));
    }
    if (migrate) await fs.cp(path.resolve(this.config.root, (await this.config.values()).MCP_OAUTH_STORE || ".mcp-oauth"), path.join(folder, "oauth"), { recursive: true }).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
  runtime(id: string): Runtime { const value = this.runtimes.get(id); if (!value) throw Object.assign(new Error("Workspace không tồn tại"), { status: 404 }); return value; }
  workspace(id: string): Workspace { const value = this.records.find(w => w.id === id); if (!value) throw Object.assign(new Error("Workspace không tồn tại"), { status: 404 }); return value; }
  list() { return this.records.map(w => ({ ...w, ...this.runtime(w.id).snapshot().mcp, tokenConfigured: !!this.token(w.id) })); }
  snapshot() { return { ...this.runtime("default").snapshot(), tunnel: this.tunnel.snapshot().tunnel, workspaces: this.list() }; }
  async listen(): Promise<void> { this.gatewayPort = +((await this.config.values()).PORT || 3000); await this.gateway.listen(this.gatewayPort); this.ready = true; }
  async refreshDefaults(): Promise<void> {
    const values = await this.config.values(), token = values.MCP_TOKEN;
    if (this.records.some(w => w.id !== "default" && this.token(w.id, true) === token)) throw new Error("MCP_TOKEN đã thuộc workspace khác");
    this.defaultToken = token; rememberSecret(token);
    const current = this.workspace("default"); current.path = path.resolve(values.WORKSPACE_PATH || this.config.root); current.autoStart = values.CONTROLLER_AUTOSTART === "true";
    await this.serialize(() => atomicJson(this.file, this.records));
  }
  private serialize<T>(task: () => Promise<T>): Promise<T> { const next = this.writes.catch(() => {}).then(task); this.writes = next; return next; }
  create(input: { name: string; path: string; preset?: string; autoStart?: boolean }): Promise<Workspace> {
    return this.serialize(async () => {
      if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 80) throw new Error("Tên workspace cần 1–80 ký tự");
      if (typeof input.path !== "string" || !path.isAbsolute(input.path) || !(await fs.stat(input.path)).isDirectory()) throw new Error("Chọn đường dẫn tuyệt đối tới thư mục dự án có sẵn");
      if (input.preset && input.preset !== "coding") throw new Error("Preset không hợp lệ");
      const workspace: Workspace = { id: randomUUID(), name: input.name.trim(), path: path.resolve(input.path), port: await this.allocate(), preset: "coding", autoStart: input.autoStart === true };
      await this.prepare(workspace); await this.vault.save({ [`workspace_${workspace.id}_token`]: randomBytes(32).toString("base64url") });
      await atomicJson(this.file, [...this.records, workspace]); this.records.push(workspace); this.attach(workspace); return workspace;
    });
  }
  update(id: string, input: { name?: string; path?: string; autoStart?: boolean }): Promise<Workspace> {
    return this.serialize(async () => {
      const workspace = this.workspace(id);
      if (!["stopped", "error"].includes(this.runtime(id).snapshot().mcp.state)) throw Object.assign(new Error("Dừng workspace trước khi sửa cấu hình"), { status: 409 });
      const next = { ...workspace };
      if (input.name !== undefined) { if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 80) throw new Error("Tên workspace không hợp lệ"); next.name = input.name.trim(); }
      if (input.path !== undefined) { if (typeof input.path !== "string" || !path.isAbsolute(input.path) || !(await fs.stat(input.path)).isDirectory()) throw new Error("Thư mục dự án không tồn tại"); next.path = path.resolve(input.path); }
      if (input.autoStart !== undefined) next.autoStart = input.autoStart === true;
      if (next.path !== workspace.path) {
        const file = path.join(this.directory(id), "mcp-upstream.json"), upstream = await loadUpstreamConfig(file);
        for (const server of upstream.servers) if (server.cwd && path.resolve(server.cwd) === workspace.path) server.cwd = next.path;
        await saveUpstreamConfig(upstream, file);
      }
      if (id === "default") await this.config.save({ WORKSPACE_PATH: next.path, CONTROLLER_AUTOSTART: String(next.autoStart) });
      await atomicJson(this.file, this.records.map(w => w.id === id ? next : w)); Object.assign(workspace, next); return workspace;
    });
  }
  async lifecycle(target: "all" | "mcp" | "tunnel", action: "start" | "stop" | "restart"): Promise<void> {
    const version = target === "mcp" ? this.lifecycleVersion : ++this.lifecycleVersion;
    if (target === "tunnel") { await this.tunnel.request("tunnel", action); return; }
    if (target === "mcp") { await this.runtime("default").request("mcp", action); return; }
    if (action !== "start") { await this.tunnel.request("tunnel", "stop"); await Promise.all(this.records.map(w => this.runtime(w.id).request("mcp", "stop"))); }
    if (action !== "stop") {
      const results = await Promise.allSettled(this.records.map(w => this.runtime(w.id).request("mcp", "start")));
      if (version !== this.lifecycleVersion) throw new Error("Khởi chạy tất cả đã hủy bởi thao tác mới");
      await this.tunnel.request("tunnel", "start");
      const failures = results.filter(r => r.status === "rejected") as PromiseRejectedResult[];
      if (failures.length) throw new Error(failures.map(r => r.reason.message).join("; "));
    }
  }
  async autostart(): Promise<void> {
    const version = ++this.lifecycleVersion;
    const enabled = this.records.filter(w => w.autoStart);
    const results = await Promise.allSettled(enabled.map(w => this.runtime(w.id).request("mcp", "start")));
    for (const result of results) if (result.status === "rejected") this.emit("log", { time: new Date().toISOString(), source: "controller", message: result.reason.message });
    if (enabled.length && version === this.lifecycleVersion) await this.tunnel.request("tunnel", "start");
  }
  async close(): Promise<void> { ++this.lifecycleVersion; this.ready = false; await this.tunnel.close(); await Promise.all([...this.runtimes.values()].map(r => r.close())); await this.gateway.close(); }
}
