import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { parse } from "dotenv";
import { secretKey, rememberSecret } from "../lib/redaction.js";

export async function atomicJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await fs.rename(temporary, file);
}
export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await fs.readFile(file, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw error; }
}
export class ConfigStore {
  private writes: Promise<unknown> = Promise.resolve();
  constructor(readonly root: string) {}
  get stateDir(): string { return path.join(this.root, ".mcp-state", "controller"); }
  async values(): Promise<Record<string, string>> {
    let text = "";
    try { text = await fs.readFile(path.join(this.root, ".env"), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const values = parse(text);
    for (const [key, value] of Object.entries(values)) if (secretKey(key)) rememberSecret(value);
    return values;
  }
  save(patch: Record<string, string>): Promise<Record<string, string>> {
    const next = this.writes.catch(() => {}).then(() => this.persist(patch));
    this.writes = next;
    return next;
  }
  private async persist(patch: Record<string, string>): Promise<Record<string, string>> {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("Config phải là object");
    for (const [key, value] of Object.entries(patch)) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== "string" || /[\r\n\0]/.test(value)) throw new Error(`Config không hợp lệ: ${key}`);
      if (/^(NODE_OPTIONS|NODE_PATH|PATH|COMSPEC|SYSTEMROOT)$/.test(key) || key.startsWith("CONTROLLER_") && key !== "CONTROLLER_AUTOSTART") throw new Error(`Không cho phép sửa ${key} qua panel`);
    }
    const values = { ...await this.values(), ...patch };
    for (const key of ["PORT", "ADMIN_PORT", "CLOUDFLARED_METRICS_PORT"]) {
      if (values[key] && (!/^\d+$/.test(values[key]) || +values[key] < 1024 || +values[key] > 65535)) throw new Error(`${key}: port phải từ 1024–65535`);
    }
    if (values.HOST && values.HOST !== "127.0.0.1") throw new Error("HOST phải là 127.0.0.1");
    const ports = [+(values.PORT || 3000), +(values.ADMIN_PORT || 3001), +(values.CLOUDFLARED_METRICS_PORT || 20241)];
    if (new Set(ports).size !== ports.length) throw new Error("MCP, admin và metrics cần port riêng");
    if (values.MCP_TOKEN && !/^[A-Za-z0-9_-]{24,}$/.test(values.MCP_TOKEN)) throw new Error("MCP_TOKEN cần ít nhất 24 ký tự URL-safe");
    const file = path.join(this.root, ".env");
    let original = "";
    try { original = await fs.readFile(file, "utf8"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    const seen = new Set<string>();
    const encode = (v: string) => {
      // dotenv expands backslash-n/r in double quotes; single/backtick quotes preserve Windows paths.
      if (!v.includes("'")) return `'${v}'`;
      if (!v.includes('`')) return '`' + v + '`';
      if (!v.includes('"') && !/\\[nr]/.test(v)) return `"${v}"`;
      throw new Error("Giá trị chứa tổ hợp dấu nháy/escape không thể biểu diễn trong dotenv");
    };
    const lines = original.split(/\r?\n/).map(line => {
      const key = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=/)?.[1];
      if (key && key in patch) { if (seen.has(key)) return ""; seen.add(key); return `${key}=${encode(patch[key])}`; }
      return line;
    });
    for (const [key, value] of Object.entries(patch)) if (!seen.has(key)) lines.push(`${key}=${encode(value)}`);
    await fs.mkdir(this.root, { recursive: true });
    const temporary = `${file}.controller.tmp`;
    await fs.writeFile(temporary, lines.join("\n"), { mode: 0o600 });
    await fs.rename(temporary, file);
    await this.values();
    return values;
  }
}
