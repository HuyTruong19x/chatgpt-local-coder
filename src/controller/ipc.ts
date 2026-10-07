import type { Router } from "express";
import { EventEmitter } from "node:events";

export interface RpcResult { status: number; data: any }
// Reuse the existing admin business handlers without opening a second HTTP listener.
// SSE is relayed separately as IPC events, never dispatched through this adapter.
export function dispatchRouter(router: Router, method: string, url: string, body?: unknown): Promise<RpcResult> {
  return new Promise(resolve => {
    const parsed = new URL(url, "http://127.0.0.1");
    const req = Object.assign(new EventEmitter(), { method, url: parsed.pathname + parsed.search, headers: {}, body, query: Object.fromEntries(parsed.searchParams), params: {}, socket: { remoteAddress: "127.0.0.1" } });
    let status = 200;
    let finished = false;
    const finish = (data: unknown) => { if (!finished) { finished = true; resolve({ status, data }); } };
    const res: any = { status(code: number) { status = code; return this; }, json: finish, send: finish, end: finish, setHeader() {}, headersSent: false };
    router(req as any, res, (error?: unknown) => { status = error ? 500 : 404; finish({ ok: false, error: error instanceof Error ? error.message : "Route không tồn tại" }); });
  });
}
