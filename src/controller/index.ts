#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { ConfigStore } from "./store.js";
import { AdminAuth } from "./auth.js";
import { Vault } from "./vault.js";
import { Runtime, availablePort } from "./runtime.js";
import { Cloudflare } from "./cloudflare.js";
import { createController } from "./server.js";
import { redactText } from "../lib/redaction.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
process.chdir(root);
const config = new ConfigStore(root);
let values = await config.values();
const port = +(values.ADMIN_PORT || 3001);
const ui = `http://127.0.0.1:${port}/ui/`;
const open = (url: string) => {
  if (process.platform !== "win32" || process.argv.includes("--no-open")) return;
  const child = spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], { windowsHide: true, detached: true, stdio: "ignore" });
  child.on("error", () => console.log(`Mở ${ui} bằng trình duyệt.`)); child.unref();
};
try { await availablePort(port); }
catch {
  const existing = await fetch(`http://127.0.0.1:${port}/controller-health`, { signal: AbortSignal.timeout(1500) }).then(r => r.json()).catch(() => null) as any;
  if (existing?.name === "chatgpt-local-controller" && !process.argv.includes("--reset-password")) { open(ui); console.log(`Panel đang chạy: ${ui}`); process.exit(0); }
  throw new Error(`Cổng admin ${port} đang dùng. Đóng controller trước khi reset; không tự dừng tiến trình khác.`);
}
const auth = new AdminAuth(path.join(config.stateDir, "admin-auth.json"));
if (process.argv.includes("--reset-password")) {
  await fs.unlink(auth.file).catch(error => { if (error.code !== "ENOENT") throw error; });
  console.log("Đã reset mật khẩu local. Vault Cloudflare được giữ nguyên.");
}
await auth.init();
const defaults: Record<string, string> = {};
for (const [key, value] of Object.entries({ HOST: "127.0.0.1", PORT: "3000", ADMIN_PORT: "3001", CHATGPT_TOOL_PROFILE: "slim", CONTROLLER_AUTOSTART: "false", WORKSPACE_PATH: root })) if (!values[key]) defaults[key] = value;
if (!values.MCP_TOKEN) defaults.MCP_TOKEN = randomBytes(32).toString("base64url");
if (Object.keys(defaults).length) values = await config.save(defaults);
for (const [key, value] of Object.entries(values)) if (!key.startsWith("OPENAI_TUNNEL_")) process.env[key] = value;
const vault = new Vault(path.join(config.stateDir, "vault.json")); await vault.init();
const runtime = new Runtime(config, vault);
const cloudflare = new Cloudflare(config, vault);
let closing = false;
const controller = await createController({ config, auth, vault, runtime, cloudflare, port, onExit: () => void close() });
const server = controller.app.listen(port, "127.0.0.1", () => {
  console.log(`Panel quản lý: ${ui}`);
  open(auth.credential ? ui : `${ui}#bootstrap=${auth.bootstrap}`);
  if (!auth.credential && process.argv.includes("--no-open")) console.log("Lần đầu: chạy launcher không có --no-open để mở link tạo mật khẩu.");
  if (auth.credential && values.CONTROLLER_AUTOSTART === "true") void runtime.request("all", "start").catch(error => runtime.log("controller", error.message));
});
server.on("error", error => { console.error(redactText(error.message)); void close(); });
async function close() {
  if (closing) return; closing = true;
  controller.closeEvents();
  await runtime.close();
  server.close(); server.closeAllConnections(); process.exit(0);
}
process.on("SIGINT", () => void close()); process.on("SIGTERM", () => void close());
process.on("uncaughtException", error => { console.error(redactText(error.message)); void close(); });
