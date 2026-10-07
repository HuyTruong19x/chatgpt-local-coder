import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);
export async function cloudflaredPath(root: string, configured?: string): Promise<string> {
  const filename = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
  const candidates = configured ? [path.resolve(root, configured)] : [path.join(root, "bin", filename), path.join(root, filename)];
  if (!configured && process.platform === "win32") {
    const found = await execute("where.exe", [filename], { windowsHide: true, timeout: 3000 }).catch(() => null);
    if (found) candidates.push(...found.stdout.trim().split(/\r?\n/));
  }
  for (const candidate of candidates) if (await fs.stat(candidate).then(s => s.isFile()).catch(() => false)) return candidate;
  throw Object.assign(new Error("Chưa tìm thấy cloudflared. Cài từ panel hoặc đặt CLOUDFLARED_PATH."), { code: "CLOUDFLARED_NOT_FOUND" });
}
export async function cloudflaredInfo(root: string, configured?: string) {
  try {
    const binary = await cloudflaredPath(root, configured);
    const result = await execute(binary, ["--version"], { windowsHide: true, timeout: 3000 });
    return { installed: true, path: binary, version: result.stdout.trim().slice(0, 200) };
  } catch (error) { return { installed: false, error: (error as Error).message }; }
}
