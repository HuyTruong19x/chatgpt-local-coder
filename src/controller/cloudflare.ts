import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ConfigStore, atomicJson, readJson } from "./store.js";
import { Vault } from "./vault.js";
import { rememberSecret, redactText } from "../lib/redaction.js";

interface Selection { accountId: string; zoneId: string; hostname: string; tunnelId?: string; name: string }
interface Plan extends Selection {
  id: string; zoneName: string; nameservers: string[]; created: string; steps: string[]; complete?: boolean;
  lastError?: { time: string; stage: string; message: string; code: string; httpStatus?: number; retryAfter?: string };
}
export class Cloudflare {
  private busy = false;
  private installing = false;
  private retryUntil = 0;
  constructor(readonly config: ConfigStore, readonly vault: Vault, private http: typeof fetch = fetch) {}
  private get file() { return path.join(this.config.stateDir, "cloudflare.json"); }
  async current(): Promise<Plan | null> { return readJson(this.file, null); }
  async api(route: string, method = "GET", body?: unknown): Promise<any> {
    if (this.retryUntil > Date.now()) {
      const retryAfter = String(Math.ceil((this.retryUntil - Date.now()) / 1000));
      throw Object.assign(new Error(`Cloudflare giới hạn request. Thử lại sau ${retryAfter} giây.`), { code: "CF_RATE_LIMIT", status: 429, retryAfter });
    }
    const token = this.vault.get("apiToken");
    if (!token) throw Object.assign(new Error("Nhập Cloudflare API token trước"), { code: "CF_TOKEN_REQUIRED" });
    const response = await this.http(`https://api.cloudflare.com/client/v4${route}`, {
      method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(25000),
    }).catch(error => {
      throw Object.assign(new Error(`Không nhận được phản hồi Cloudflare (${method}): ${redactText(String(error.message))}. Bấm Tiếp tục / thử lại; server sẽ kiểm tra tunnel đã tạo trước khi gửi lại.`), { code: "CF_NETWORK", status: 502 });
    });
    if (response.status === 429) {
      const header = response.headers.get("retry-after") || "60";
      const seconds = /^\d+$/.test(header) ? +header : Math.ceil((Date.parse(header) - Date.now()) / 1000);
      const retryAfter = String(Number.isFinite(seconds) && seconds > 0 ? seconds : 60);
      this.retryUntil = Date.now() + +retryAfter * 1000;
      throw Object.assign(new Error(`Cloudflare giới hạn request. Thử lại sau ${retryAfter} giây.`), { code: "CF_RATE_LIMIT", status: 429, retryAfter });
    }
    const data = await response.json().catch(() => ({ success: false, errors: [{ message: `HTTP ${response.status}: phản hồi không phải JSON` }] })) as any;
    if (!response.ok || !data.success) {
      const details = data.errors?.map((e: any) => `${e.code ? `[${e.code}] ` : ""}${e.message || "API error"}`).join("; ") || "API error";
      const permission = response.status === 401 || response.status === 403;
      const hint = permission ? (route.includes("/cfd_tunnel")
        ? " Kiểm tra token có Account → Cloudflare Tunnel → Edit trên đúng account; quyền Read chỉ tải được danh sách."
        : route.includes("/dns_records") ? " Kiểm tra token có Zone → DNS → Edit trên đúng domain." : " Kiểm tra API token còn hiệu lực và được phép truy cập account/domain này.") : "";
      throw Object.assign(new Error(redactText(`Cloudflare HTTP ${response.status} (${method}): ${details}.${hint}`)), { code: permission ? "CF_PERMISSION" : "CF_API", status: 400, httpStatus: response.status });
    }
    return data.result;
  }
  private async list(route: string): Promise<any[]> {
    const result: any[] = [];
    for (let page = 1; page <= 100; page++) {
      const rows = await this.api(`${route}${route.includes("?") ? "&" : "?"}per_page=50&page=${page}`);
      result.push(...rows);
      if (rows.length < 50) return result;
    }
    throw new Error("Danh sách quá lớn; thu hẹp quyền token về account/zone cần dùng.");
  }
  async connect(token: string): Promise<any> {
    if (this.busy) throw new Error("Chờ thao tác Cloudflare hiện tại hoàn tất trước khi đổi token");
    if (typeof token !== "string" || token.length < 20 || token.length > 2048 || /\s/.test(token)) throw new Error("API token không hợp lệ");
    const previous = this.vault.get("apiToken");
    this.busy = true;
    try {
      await this.vault.save({ apiToken: token });
      const verification = await this.api("/user/tokens/verify");
      if (verification.status !== "active") throw new Error("Token chưa active");
      return await this.zones();
    } catch (error) { await this.vault.save({ apiToken: previous || "" }); throw error; }
    finally { this.busy = false; }
  }
  async zones(): Promise<any[]> {
    return (await this.list("/zones")).map(z => ({ id: z.id, name: z.name, status: z.status, account: z.account, nameservers: z.name_servers }));
  }
  async tunnels(accountId: string): Promise<any[]> {
    this.id(accountId);
    return (await this.list(`/accounts/${accountId}/cfd_tunnel?is_deleted=false`)).filter(t => t.config_src === "cloudflare").map(t => ({ id: t.id, name: t.name, status: t.status }));
  }
  private id(value: string): void { if (!/^[a-f0-9]{32}$/i.test(value || "")) throw new Error("Account/zone ID không hợp lệ"); }
  private tunnelId(value: string): void { if (!/^[a-f0-9-]{36}$/i.test(value || "")) throw new Error("Tunnel ID không hợp lệ"); }
  async preview(selection: Selection): Promise<Plan> {
    if (this.busy) throw new Error("Đang áp dụng cấu hình Cloudflare");
    const unfinished = await readJson<Plan | null>(path.join(this.config.stateDir, "cloudflare-plan.json"), null);
    this.id(selection.accountId); this.id(selection.zoneId);
    if (selection.tunnelId) this.tunnelId(selection.tunnelId);
    if (unfinished && !unfinished.complete && unfinished.steps.length) {
      const same = unfinished.accountId === selection.accountId && unfinished.zoneId === selection.zoneId
        && unfinished.hostname === String(selection.hostname || "").toLowerCase().trim() && unfinished.name === selection.name
        && (!selection.tunnelId || unfinished.tunnelId === selection.tunnelId);
      if (same) return unfinished;
      throw Object.assign(new Error(`Setup ${unfinished.hostname} chưa hoàn tất. Bấm Tiếp tục / thử lại trong preview đã lưu trước khi đổi cấu hình.`), { code: "CF_SETUP_UNFINISHED", status: 409 });
    }
    const zone = await this.api(`/zones/${selection.zoneId}`);
    if (zone.account?.id !== selection.accountId) throw new Error("Zone không thuộc account đã chọn");
    if (zone.status !== "active") throw Object.assign(new Error(`Domain chưa active. Đổi nameserver tại nơi mua domain: ${(zone.name_servers || []).join(", ")}`), { code: "CF_ZONE_PENDING" });
    const hostname = String(selection.hostname || "").toLowerCase().trim();
    if (!hostname.endsWith(`.${zone.name}`) || hostname.length > 253 || !hostname.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw new Error("Hostname phải là subdomain của zone đã chọn");
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(selection.name || "")) throw new Error("Tên tunnel chỉ dùng chữ, số, dấu - hoặc _ (tối đa 64)");
    if (selection.tunnelId && !(await this.tunnels(selection.accountId)).some(t => t.id === selection.tunnelId)) throw new Error("Tunnel phải thuộc account và dùng config_src=cloudflare");
    const records = await this.api(`/zones/${selection.zoneId}/dns_records?name=${encodeURIComponent(hostname)}`);
    if (records.some((r: any) => r.type !== "CNAME" || !selection.tunnelId || r.content !== `${selection.tunnelId}.cfargotunnel.com`)) throw Object.assign(new Error("Hostname đã có DNS khác. Chọn hostname khác hoặc xử lý DNS thủ công."), { code: "CF_DNS_CONFLICT" });
    if (selection.tunnelId) {
      const existing = await this.api(`/accounts/${selection.accountId}/cfd_tunnel/${selection.tunnelId}/configurations`);
      const prior = await this.current();
      if ((existing.config?.ingress || []).some((r: any) => r.hostname === hostname) && !(prior?.hostname === hostname && prior.tunnelId === selection.tunnelId)) throw new Error("Tunnel đã có ingress cho hostname này; không tự ghi đè.");
    }
    const plan: Plan = { ...selection, hostname, id: randomUUID(), zoneName: zone.name, nameservers: zone.name_servers || [], created: new Date().toISOString(), steps: [] };
    await atomicJson(path.join(this.config.stateDir, "cloudflare-plan.json"), plan);
    return plan;
  }
  async apply(planId: string): Promise<Plan> {
    if (this.busy) throw Object.assign(new Error("Đang áp dụng cấu hình"), { status: 409 });
    this.busy = true;
    let savedPlan: Plan | null = null, stage = "Kiểm tra preview";
    try {
      const plan = await readJson<Plan | null>(path.join(this.config.stateDir, "cloudflare-plan.json"), null);
      if (!plan || plan.id !== planId) throw new Error("Preview không tồn tại hoặc đã thay đổi");
      savedPlan = plan;
      delete plan.lastError;
      const save = async (step?: string) => {
        if (step && !plan.steps.includes(step)) plan.steps.push(step);
        await atomicJson(path.join(this.config.stateDir, "cloudflare-plan.json"), plan);
      };
      stage = "Kiểm tra domain và DNS";
      const zone = await this.api(`/zones/${plan.zoneId}`);
      if (zone.status !== "active" || zone.account?.id !== plan.accountId) throw new Error("Zone không còn active hoặc account đã thay đổi");
      // Recheck DNS before any mutation; a competing change must never be overwritten.
      let records = await this.api(`/zones/${plan.zoneId}/dns_records?name=${encodeURIComponent(plan.hostname)}`);
      if (records.some((r: any) => r.type !== "CNAME" || !plan.tunnelId || r.content !== `${plan.tunnelId}.cfargotunnel.com`)) throw new Error("DNS đã thay đổi sau preview. Không áp dụng.");
      if (!plan.tunnelId) {
        stage = "Tạo tunnel";
        const matches = (await this.tunnels(plan.accountId)).filter(t => t.name === plan.name);
        // Save the create intent first. An ambiguous network failure can then be resumed by name.
        if (matches.length && !plan.steps.includes("create-requested")) throw new Error("Tên tunnel đã tồn tại. Chọn tunnel đó hoặc đổi tên.");
        if (matches.length > 1) throw new Error("Nhiều tunnel trùng tên; chọn tunnel thủ công.");
        await save("create-requested");
        const tunnel = matches[0] || await this.api(`/accounts/${plan.accountId}/cfd_tunnel`, "POST", { name: plan.name, config_src: "cloudflare" });
        plan.tunnelId = tunnel.id;
        await save("tunnel-created");
      }
      stage = "Lấy token chạy tunnel";
      const tunnelToken = await this.api(`/accounts/${plan.accountId}/cfd_tunnel/${plan.tunnelId}/token`);
      rememberSecret(tunnelToken); await this.vault.save({ tunnelToken, tunnelId: plan.tunnelId! });
      await save("token-stored");
      stage = "Cấu hình ingress";
      const existing = await this.api(`/accounts/${plan.accountId}/cfd_tunnel/${plan.tunnelId}/configurations`);
      const ingress = existing.config?.ingress || [];
      const prior = await this.current();
      const sameHost = ingress.filter((r: any) => r.hostname === plan.hostname);
      const expectedPath = "^/mcp/[A-Za-z0-9_-]{24,}$";
      const values = await this.config.values();
      if (sameHost.length && !(prior?.hostname === plan.hostname && prior.tunnelId === plan.tunnelId) && !sameHost.every((r: any) => r.path === expectedPath && r.service === `http://127.0.0.1:${values.PORT || 3000}`)) throw new Error("Ingress hostname đã thay đổi. Không ghi đè.");
      const kept = ingress.filter((r: any) => r.hostname !== plan.hostname && (r.hostname || r.path));
      await this.api(`/accounts/${plan.accountId}/cfd_tunnel/${plan.tunnelId}/configurations`, "PUT", { config: { ...existing.config, ingress: [...kept, { hostname: plan.hostname, path: expectedPath, service: `http://127.0.0.1:${values.PORT || 3000}` }, { service: "http_status:404" }] } });
      await save("ingress-configured");
      stage = "Cấu hình DNS";
      records = await this.api(`/zones/${plan.zoneId}/dns_records?name=${encodeURIComponent(plan.hostname)}`);
      if (records.some((r: any) => r.type !== "CNAME" || r.content !== `${plan.tunnelId}.cfargotunnel.com`)) throw new Error("DNS xung đột. Tunnel đã được tạo; DNS chưa bị sửa.");
      const dns = { type: "CNAME", name: plan.hostname, content: `${plan.tunnelId}.cfargotunnel.com`, proxied: true, ttl: 1 };
      if (records.length) { if (!records[0].proxied) await this.api(`/zones/${plan.zoneId}/dns_records/${records[0].id}`, "PATCH", dns); }
      else await this.api(`/zones/${plan.zoneId}/dns_records`, "POST", dns);
      await save("dns-configured");
      plan.complete = true;
      await atomicJson(this.file, plan); await save("complete");
      return plan;
    } catch (error: any) {
      if (savedPlan?.id === planId) {
        savedPlan.lastError = { time: new Date().toISOString(), stage, message: redactText(String(error.message)), code: error.code || "CF_SETUP", httpStatus: error.httpStatus, retryAfter: error.retryAfter };
        await atomicJson(path.join(this.config.stateDir, "cloudflare-plan.json"), savedPlan);
      }
      throw error;
    } finally { this.busy = false; }
  }
  async install(canInstall = () => true): Promise<{ version: string; path: string }> {
    if (this.installing || !canInstall()) throw new Error("Dừng tunnel và chờ lượt cài trước hoàn tất");
    this.installing = true;
    try {
    if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Tải tự động hiện hỗ trợ Windows x64");
    const releaseResponse = await this.http("https://api.github.com/repos/cloudflare/cloudflared/releases/latest", { headers: { "User-Agent": "ChatGPT-Local-Controller" }, signal: AbortSignal.timeout(25000) });
    if (!releaseResponse.ok) throw new Error(`Không đọc được release cloudflared: HTTP ${releaseResponse.status}`);
    const release = await releaseResponse.json() as any;
    const asset = release.assets?.find((a: any) => a.name === "cloudflared-windows-amd64.exe");
    const checksum = asset?.digest?.match(/^sha256:([a-f0-9]{64})$/i)?.[1] || release.body?.match(/cloudflared-windows-amd64\.exe[^\n]*?([a-f0-9]{64})/i)?.[1];
    if (!asset || !checksum || !String(asset.browser_download_url).startsWith("https://github.com/cloudflare/cloudflared/releases/download/")) throw new Error("Release thiếu SHA256 chính thức; không cài file chưa kiểm chứng.");
    const response = await this.http(asset.browser_download_url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`Tải cloudflared thất bại: ${response.status}`);
    if (+response.headers.get("content-length")! > 100_000_000) throw new Error("File quá lớn");
    const chunks: Uint8Array[] = []; let size = 0;
    for await (const chunk of response.body as any) { size += chunk.length; if (size > 100_000_000) throw new Error("File quá lớn"); chunks.push(chunk); }
    const bytes = Buffer.concat(chunks);
    if (createHash("sha256").update(bytes).digest("hex") !== checksum.toLowerCase()) throw new Error("SHA256 không khớp. Không cài binary.");
    const binary = path.join(this.config.root, "bin", "cloudflared.exe");
    if (!canInstall()) throw new Error("Tunnel đã khởi chạy trong lúc tải. Dừng tunnel rồi thử lại.");
    await fs.mkdir(path.dirname(binary), { recursive: true });
    await fs.writeFile(`${binary}.download`, bytes); await fs.rename(`${binary}.download`, binary);
    await this.config.save({ CLOUDFLARED_PATH: binary });
    return { version: release.tag_name, path: binary };
    } finally { this.installing = false; }
  }
}
