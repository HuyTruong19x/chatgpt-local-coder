import { spawn } from "node:child_process";
import { atomicJson, readJson } from "./store.js";
import { rememberSecret, secretKey } from "../lib/redaction.js";

export type Protector = (value: string, decrypt: boolean) => Promise<string>;
// Secret data travels over stdin; never as a command-line argument or console log.
export const dpapi: Protector = async (value, decrypt) => {
  if (process.platform !== "win32") throw new Error("Credential vault yêu cầu Windows DPAPI");
  const script = `Add-Type -AssemblyName System.Security; $v=[Console]::In.ReadToEnd(); $b=[Convert]::FromBase64String($v); $r=[Security.Cryptography.ProtectedData]::${decrypt ? "Unprotect" : "Protect"}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))`;
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
    let output = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("DPAPI timeout")); }, 15000);
    child.stdout.on("data", data => { output += String(data); });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => { clearTimeout(timer); code === 0 ? resolve(output.trim()) : reject(new Error("Không thể mở vault bằng tài khoản Windows hiện tại")); });
    child.stdin.on("error", () => {});
    child.stdin.end(decrypt ? value : Buffer.from(value, "utf8").toString("base64"));
  }).then(text => decrypt ? Buffer.from(text as string, "base64").toString("utf8") : text as string);
};
export class Vault {
  private values: Record<string, string> = {};
  private writes: Promise<unknown> = Promise.resolve();
  constructor(readonly file: string, private protect: Protector = dpapi) {}
  async init(): Promise<void> {
    const ciphertext = await readJson<{ ciphertext: string } | null>(this.file, null);
    if (ciphertext) this.values = JSON.parse(await this.protect(ciphertext.ciphertext, true));
    for (const [key, value] of Object.entries(this.values)) if (secretKey(key)) rememberSecret(value);
  }
  get(key: string): string { return this.values[key] || ""; }
  all(): Record<string, string> { return { ...this.values }; }
  save(patch: Record<string, string>): Promise<void> {
    const next = this.writes.catch(() => {}).then(() => this.persist(patch)); this.writes = next; return next;
  }
  private async persist(patch: Record<string, string>): Promise<void> {
    const next = { ...this.values, ...patch };
    for (const [key, value] of Object.entries(next)) if (secretKey(key)) rememberSecret(value);
    const ciphertext = await this.protect(JSON.stringify(next), false);
    await atomicJson(this.file, { version: 1, protection: "Windows-DPAPI-CurrentUser", ciphertext });
    this.values = next;
  }
}
