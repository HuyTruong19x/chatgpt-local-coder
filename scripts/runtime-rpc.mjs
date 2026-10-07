import { fork } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
export function managedRuntime(root, env = {}) {
  const child = fork(path.join(root, 'dist/index.js'), [], { cwd: root, env: { ...process.env, ...env, CONTROLLER_MANAGED: '1' }, silent: true, windowsHide: true });
  const pending = new Map();
  child.on('message', message => { if (message?.type !== 'rpc-result') return; const call = pending.get(message.id); if (call) { clearTimeout(call.timer); pending.delete(message.id); call.resolve(message); } });
  child.on('exit', () => { for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error('Runtime exited')); } pending.clear(); });
  const rpc = (method, url, body) => new Promise((resolve, reject) => { const id = randomUUID(); const timer = setTimeout(() => { pending.delete(id); reject(new Error(`IPC timeout ${url}`)); }, 20000); pending.set(id, { resolve, reject, timer }); child.send({ type: 'rpc', id, method, url, body }); });
  const stop = () => new Promise(resolve => { if (child.exitCode !== null) { resolve(); return; } const timer = setTimeout(() => child.kill(), 5000); child.once('exit', () => { clearTimeout(timer); resolve(); }); if (child.connected) child.send({ type: 'shutdown' }); else child.kill(); });
  return { child, rpc, stop };
}
