import { randomBytes, scrypt as derive, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { Request, Response } from "express";
import { atomicJson, readJson } from "./store.js";

const scrypt = promisify(derive);
interface Credential { salt: string; hash: string }
export interface Session { id: string; csrf: string; created: number; touched: number; verified: number }
export class AdminAuth {
  credential: Credential | null = null;
  readonly bootstrap = randomBytes(32).toString("base64url");
  private sessions = new Map<string, Session>();
  private failures: number[] = [];
  private lockedUntil = 0;
  constructor(readonly file: string, private now = () => Date.now()) {}
  async init(): Promise<void> { this.credential = await readJson<Credential | null>(this.file, null); }
  async setPassword(password: string): Promise<void> {
    if (typeof password !== "string" || password.length < 12 || password.length > 256) throw new Error("Mật khẩu cần 12–256 ký tự");
    const salt = randomBytes(32).toString("hex");
    const hash = (await scrypt(password, salt, 64) as Buffer).toString("hex");
    await atomicJson(this.file, { salt, hash });
    this.credential = { salt, hash };
    this.sessions.clear(); this.failures = []; this.lockedUntil = 0;
  }
  async verify(password: unknown): Promise<boolean> {
    if (!this.credential || typeof password !== "string" || password.length > 256) return false;
    const computed = await scrypt(password, this.credential.salt, 64) as Buffer;
    const expected = Buffer.from(this.credential.hash, "hex");
    return computed.length === expected.length && timingSafeEqual(computed, expected);
  }
  async login(password: unknown): Promise<Session> {
    if (this.lockedUntil > this.now()) throw Object.assign(new Error("Thử lại sau 15 phút"), { status: 429, code: "LOGIN_LOCKED" });
    if (!await this.verify(password)) {
      this.failures = this.failures.filter(time => time > this.now() - 900_000);
      this.failures.push(this.now());
      if (this.failures.length >= 5) this.lockedUntil = this.now() + 900_000;
      throw Object.assign(new Error("Mật khẩu không đúng"), { status: 401, code: "INVALID_PASSWORD" });
    }
    this.failures = []; this.lockedUntil = 0;
    const session = { id: randomBytes(32).toString("base64url"), csrf: randomBytes(32).toString("base64url"), created: this.now(), touched: this.now(), verified: 0 };
    // Logging in is not a sensitive-action reauthentication.
    if (this.sessions.size >= 20) this.sessions.delete(this.sessions.keys().next().value!);
    this.sessions.set(session.id, session);
    return session;
  }
  valid(session: Session): boolean {
    const valid = this.sessions.get(session.id) === session && this.now() - session.touched < 1_800_000 && this.now() - session.created < 28_800_000;
    if (!valid) this.sessions.delete(session.id);
    return valid;
  }
  session(req: Request): Session | undefined {
    const id = req.headers.cookie?.split(";").map(v => v.trim()).find(v => v.startsWith("local_coder_session="))?.slice(20);
    const session = id ? this.sessions.get(id) : undefined;
    if (!session) return;
    if (!this.valid(session)) return;
    session.touched = this.now();
    return session;
  }
  cookie(res: Response, session?: Session): void {
    res.setHeader("Set-Cookie", `local_coder_session=${session?.id || ""}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${session ? 28800 : 0}`);
  }
  logout(session: Session): void { this.sessions.delete(session.id); }
  async reauthenticate(session: Session, password: unknown): Promise<void> {
    const check = await this.login(password); this.sessions.delete(check.id);
    session.verified = this.now();
  }
  requireRecent(session: Session): void {
    if (!session.verified || this.now() - session.verified > 300_000) throw Object.assign(new Error("Xác nhận lại mật khẩu để xem bí mật"), { status: 403, code: "REAUTH_REQUIRED" });
  }
}
