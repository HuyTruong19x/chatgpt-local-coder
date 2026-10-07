import { fork, spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import net from "node:net";
import path from "node:path";
import { ConfigStore } from "./store.js";
import { Vault } from "./vault.js";
import { redact, redactText, secretKey } from "../lib/redaction.js";
import type { RpcResult } from "./ipc.js";
import { cloudflaredPath } from "./binary.js";

type Target = "mcp" | "tunnel";
export interface ServiceState { state: string; pid?: number; retries: number; error?: string; since?: string }
interface Service { child?: ChildProcess; desired: boolean; state: ServiceState; retry?: NodeJS.Timeout; stable?: NodeJS.Timeout; abort?: AbortController }
export async function availablePort(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", () => reject(Object.assign(new Error(`Cổng ${port} đang được sử dụng. Không dừng tiến trình khác tự động.`), { code: "PORT_BUSY" })));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve()));
  });
}
export class Runtime extends EventEmitter {
  private services: Record<Target, Service> = {
    mcp: { desired: false, state: { state: "stopped", retries: 0 } },
    tunnel: { desired: false, state: { state: "stopped", retries: 0 } },
  };
  private pending = new Map<string, { resolve: (result: RpcResult) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private queue: Promise<unknown> = Promise.resolve();
  private monitor?: NodeJS.Timeout;
  private metricsPort = 20241;
  activeConfig: Record<string, string> | null = null;
  constructor(readonly config: ConfigStore, readonly vault: Vault, private entry = path.join(config.root, "dist", "index.js"), private retryDelays = [2000, 5000, 15000], private launch = { fork, spawn }) {
    super();
    this.monitor = setInterval(() => void this.updateReadiness(), 5000);
    this.monitor.unref();
  }
  snapshot() { return { mcp: { ...this.services.mcp.state }, tunnel: { ...this.services.tunnel.state }, activeConfig: this.activeConfig }; }
  private update(target: Target, patch: Partial<ServiceState>): void {
    Object.assign(this.services[target].state, patch);
    this.emit("status", this.snapshot());
  }
  log(source: string, message: string): void { this.emit("log", { time: new Date().toISOString(), source, message: redactText(message).slice(0, 8000) }); }
  private capture(child: ChildProcess, source: string): void {
    for (const stream of [child.stdout, child.stderr]) {
      let pending = "";
      stream?.on("data", data => {
        pending += String(data);
        const lines = pending.split(/\r?\n/); pending = lines.pop() || "";
        for (const line of lines) if (line) this.log(source, line);
        if (pending.length > 32768) { this.log(source, "[Dòng log dài đã bỏ]"); pending = ""; }
      });
      stream?.on("end", () => { if (pending) this.log(source, pending); });
    }
  }
  request(target: Target | "all", action: "start" | "stop" | "restart"): Promise<void> {
    if (action !== "start") for (const name of target === "all" || target === "mcp" && action === "stop" ? ["tunnel", "mcp"] as Target[] : [target]) {
      const svc = this.services[name]; svc.desired = false; svc.abort?.abort(); clearTimeout(svc.retry); svc.retry = undefined;
    }
    const run = async () => {
      if (action !== "start") {
        if (target === "all" || target === "mcp") await this.stop("tunnel", target === "all");
        if (target === "all" || target === "mcp") await this.stop("mcp", true);
        if (target === "tunnel") await this.stop("tunnel", true);
      }
      if (action !== "stop") {
        if (target === "all" || target === "mcp" || target === "tunnel") await this.start("mcp");
        if (target === "all" || target === "tunnel" || (target === "mcp" && this.services.tunnel.desired)) await this.start("tunnel");
      }
    };
    const next = this.queue.catch(() => {}).then(run); this.queue = next; return next;
  }
  private async start(target: Target, recovery = false): Promise<void> {
    const service = this.services[target];
    if (service.child) return;
    const values = await this.config.values();
    if (!/^[A-Za-z0-9_-]{24,}$/.test(values.MCP_TOKEN || "")) throw Object.assign(new Error("Tạo MCP_TOKEN trước khi khởi chạy"), { code: "MCP_TOKEN_REQUIRED" });
    if (!recovery) service.state.retries = 0;
    service.desired = true; service.abort = new AbortController();
    this.update(target, { state: "starting", error: undefined });
    try {
      let child: ChildProcess;
      if (target === "mcp") {
        await availablePort(+(values.PORT || 3000));
        const env = { ...process.env, ...values, HOST: "127.0.0.1", CONTROLLER_MANAGED: "1", MCP_OAUTH_CALLBACK_BASE: `http://127.0.0.1:${values.ADMIN_PORT || 3001}` };
        for (const key of Object.keys(env)) if (/^(OPENAI_TUNNEL_|CLOUDFLARE_|ADMIN_TOKEN)/.test(key)) delete (env as NodeJS.ProcessEnv)[key];
        child = this.launch.fork(this.entry, [], { cwd: this.config.root, env, silent: true, windowsHide: true } as Parameters<typeof fork>[2]);
        this.activeConfig = { ...values, HOST: "127.0.0.1" };
        child.on("message", (message: any) => {
          if (message?.type === "rpc-result") {
            const pending = this.pending.get(message.id);
            if (pending) { clearTimeout(pending.timer); this.pending.delete(message.id); pending.resolve({ status: message.status, data: message.data }); }
          } else if (message?.type === "activity") this.emit("activity", redact(message.data));
        });
      } else {
        if (!this.services.mcp.child || this.services.mcp.state.state !== "running") throw new Error("MCP chưa sẵn sàng");
        const token = this.vault.get("tunnelToken");
        if (!token) throw new Error("Hoàn tất setup Cloudflare trước");
        this.metricsPort = +(values.CLOUDFLARED_METRICS_PORT || 20241);
        await availablePort(this.metricsPort);
        const binary = await cloudflaredPath(this.config.root, values.CLOUDFLARED_PATH);
        const tunnelEnv: NodeJS.ProcessEnv = { ...process.env };
        for (const key of Object.keys(tunnelEnv)) if (secretKey(key)) delete tunnelEnv[key];
        tunnelEnv.TUNNEL_TOKEN = token;
        child = this.launch.spawn(binary, ["tunnel", "--no-autoupdate", "--metrics", `127.0.0.1:${this.metricsPort}`, "run"], {
          cwd: this.config.root, windowsHide: true, env: tunnelEnv, stdio: ["ignore", "pipe", "pipe"],
        });
      }
      service.child = child;
      this.capture(child, target);
      child.once("error", error => this.log(target, error.message));
      child.once("exit", (code, signal) => this.exited(target, child, `Tiến trình thoát (${code ?? signal})`));
      child.once("error", error => this.exited(target, child, error.message));
      this.update(target, { pid: child.pid, since: new Date().toISOString() });
      const deadline = Date.now() + 25_000;
      while (Date.now() < deadline) {
        if (service.abort.signal.aborted || !service.child) throw new Error("Khởi chạy đã hủy hoặc tiến trình đã thoát");
        try {
          const response = await fetch(target === "mcp" ? `http://127.0.0.1:${values.PORT || 3000}/health` : `http://127.0.0.1:${this.metricsPort}/ready`, { signal: AbortSignal.timeout(1500) });
          if (response.ok) {
            this.update(target, { state: target === "mcp" ? "running" : "connected" });
            clearTimeout(service.stable);
            service.stable = setTimeout(() => this.update(target, { retries: 0 }), 60_000); service.stable.unref();
            return;
          }
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      if (target === "tunnel" && service.child) {
        this.update(target, { state: "degraded", error: "cloudflared đang chạy nhưng chưa kết nối; đang theo dõi /ready" });
        return;
      }
      throw new Error("MCP chưa sẵn sàng sau 25 giây");
    } catch (error) {
      const wanted = service.desired;
      await this.stop(target, false);
      this.update(target, { state: "error", error: redactText(error instanceof Error ? error.message : String(error)) });
      service.desired = wanted;
      this.scheduleRecovery(target);
      throw error;
    }
  }
  private exited(target: Target, child: ChildProcess, error: string): void {
    const service = this.services[target];
    if (service.child !== child) return;
    service.child = undefined;
    clearTimeout(service.stable);
    if (target === "mcp") this.activeConfig = null;
    if (target === "mcp") for (const [id, pending] of this.pending) { clearTimeout(pending.timer); pending.reject(new Error("MCP đã dừng")); this.pending.delete(id); }
    this.update(target, { state: service.desired ? "error" : "stopped", pid: undefined, error: service.desired ? error : undefined });
    if (target === "mcp" && this.services.tunnel.child) void this.stop("tunnel", false);
    this.scheduleRecovery(target);
  }
  private scheduleRecovery(target: Target): void {
    const svc = this.services[target];
    if (!svc.desired || svc.retry || svc.state.retries >= this.retryDelays.length) return;
    const delay = this.retryDelays[svc.state.retries++];
    svc.retry = setTimeout(() => {
      svc.retry = undefined;
      if (!svc.desired) return;
      const recover = async () => {
        if (!svc.desired) return;
        if (target === "tunnel" && this.services.mcp.state.state !== "running") { this.scheduleRecovery(target); return; }
        await this.start(target, true);
        if (target === "mcp" && this.services.tunnel.desired && !this.services.tunnel.child) await this.start("tunnel", true);
      };
      this.queue = this.queue.catch(() => {}).then(recover).catch(error => this.log("controller", String(error.message)));
    }, delay);
    svc.retry.unref();
    this.emit("status", this.snapshot());
  }
  private async stop(target: Target, reset: boolean): Promise<void> {
    const svc = this.services[target];
    if (reset) { svc.desired = false; clearTimeout(svc.retry); svc.retry = undefined; svc.state.retries = 0; }
    clearTimeout(svc.stable); svc.abort?.abort();
    const child = svc.child;
    if (!child) { this.update(target, { state: "stopped", pid: undefined }); return; }
    this.update(target, { state: "stopping" });
    // Detach the owned child before signalling, so intentional Stop cannot trigger recovery.
    svc.child = undefined;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        if (process.platform === "win32" && child.pid && child.exitCode === null) {
          const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
          killer.once("error", () => resolve()); killer.once("exit", () => resolve());
        } else { child.kill("SIGKILL"); resolve(); }
      }, 10_000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      if (target === "mcp" && child.connected) child.send({ type: "shutdown" }, () => {});
      else child.kill();
      if (child.exitCode !== null) { clearTimeout(timer); resolve(); }
    });
    if (target === "mcp") {
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("MCP đã dừng")); }
      this.pending.clear(); this.activeConfig = null;
    }
    this.update(target, { state: "stopped", pid: undefined, error: undefined });
  }
  async rpc(method: string, url: string, body?: unknown): Promise<RpcResult> {
    const child = this.services.mcp.child;
    if (!child?.connected || this.services.mcp.state.state !== "running") throw Object.assign(new Error("Khởi chạy MCP để dùng chức năng này"), { status: 409, code: "MCP_STOPPED" });
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("MCP IPC timeout")); }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      child.send({ type: "rpc", id, method, url, body }, error => { if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); } });
    });
  }
  private async updateReadiness(): Promise<void> {
    if (!this.services.tunnel.child || !["connected", "degraded"].includes(this.services.tunnel.state.state)) return;
    try { const r = await fetch(`http://127.0.0.1:${this.metricsPort}/ready`, { signal: AbortSignal.timeout(2000) }); this.update("tunnel", { state: r.ok ? "connected" : "degraded", error: r.ok ? undefined : "Tunnel chưa connected" }); }
    catch { this.update("tunnel", { state: "degraded" }); }
  }
  async close(): Promise<void> { clearInterval(this.monitor); await this.request("all", "stop"); }
}
