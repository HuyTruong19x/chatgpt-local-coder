// Browser smoke test using the installed Chrome/Edge and native DevTools protocol.
// Isolated local fixtures; Cloudflare API is mocked and no purchased domain is changed.
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
const root = path.resolve(import.meta.dirname, '..');
const scratch = await fs.mkdtemp(path.join(root, '.tool-test-tmp/admin-ui-'));
process.env.MCP_UPSTREAM_CONFIG = path.join(scratch, 'upstream.json');
process.env.AUDIT_LOG_PATH = path.join(scratch, 'audit.log');
await fs.writeFile(process.env.MCP_UPSTREAM_CONFIG, JSON.stringify({ version: 1, servers: [] }));
const { AdminAuth } = await import('../dist/controller/auth.js');
const { ConfigStore } = await import('../dist/controller/store.js');
const { Vault } = await import('../dist/controller/vault.js');
const { Runtime } = await import('../dist/controller/runtime.js');
const { WorkspaceManager } = await import('../dist/controller/workspaces.js');
const { Cloudflare } = await import('../dist/controller/cloudflare.js');
const { createController } = await import('../dist/controller/server.js');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() { const s = net.createServer().listen(0, '127.0.0.1'); await once(s, 'listening'); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
const port = await freePort(), mcpPort = await freePort(), devtoolsPort = await freePort();
const config = new ConfigStore(scratch);
await config.save({ HOST: '127.0.0.1', PORT: String(mcpPort), ADMIN_PORT: String(port), MCP_TOKEN: 'ui_mcp_token_abcdefghijklmnopqrstuvwxyz', WORKSPACE_PATH: scratch, MCP_UPSTREAM_CONFIG: process.env.MCP_UPSTREAM_CONFIG });
await fs.cp(path.join(root, 'public/controller'), path.join(scratch, 'public/controller'), { recursive: true });
const auth = new AdminAuth(path.join(config.stateDir, 'admin.json')); await auth.init();
const vault = new Vault(path.join(config.stateDir, 'vault.json'), async (v, decrypt) => decrypt ? Buffer.from(v, 'base64').toString() : Buffer.from(v).toString('base64')); await vault.init();
const accountId = 'a'.repeat(32), zoneId = 'b'.repeat(32), tunnelId = '12345678-1234-1234-1234-123456789012';
let records = [], tunnels = [], ingress = [], mutations = 0, denyCreate = true;
const cloudflare = new Cloudflare(config, vault, async (url, init = {}) => {
  const route = new URL(url).pathname.replace('/client/v4', ''), method = init.method || 'GET'; let result;
  if (method !== 'GET') mutations++;
  if (route === '/user/tokens/verify') result = { status: 'active' };
  else if (route === '/zones' || route === `/zones/${zoneId}`) { const zone = { id: zoneId, name: 'example.com', status: 'active', account: { id: accountId, name: 'Test Account' }, name_servers: [] }; result = route === '/zones' ? [zone] : zone; }
  else if (route.endsWith('/cfd_tunnel')) {
    if (method === 'POST' && denyCreate) return Response.json({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }, { status: 403 });
    if (method === 'POST') tunnels = [{ id: tunnelId, name: 'chatgpt-local', config_src: 'cloudflare' }]; result = method === 'POST' ? tunnels[0] : tunnels;
  }
  else if (route.endsWith('/token')) result = 'ui_fake_tunnel_token_abcdefghijklmnopqrstuvwxyz';
  else if (route.endsWith('/configurations')) { if (method === 'PUT') ingress = JSON.parse(init.body).config.ingress; result = { config: { ingress } }; }
  else if (route.endsWith('/dns_records')) { if (method === 'POST') records = [{ ...JSON.parse(init.body), id: 'dns-id' }]; result = records; }
  else throw new Error(`Unexpected mocked API ${route}`);
  return Response.json({ success: true, result });
});
const workspaces = new WorkspaceManager(config, vault, path.join(root, 'dist/index.js')); await workspaces.init(); await workspaces.listen();
const runtime = workspaces.runtime('default');
const controller = await createController({ config, auth, vault, runtime, cloudflare, workspaces, port });
const server = controller.app.listen(port, '127.0.0.1'); await once(server, 'listening');
let binary;
for (const candidate of [process.env.CHROME_BINARY, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']) if (candidate && await fs.access(candidate).then(() => true).catch(() => false)) { binary = candidate; break; }
if (!binary) throw new Error('No Chrome/Edge found. Set CHROME_BINARY.');
const browser = spawn(binary, ['--headless=new', '--disable-gpu', '--disable-background-networking', '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${devtoolsPort}`, `--user-data-dir=${path.join(scratch, 'browser')}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
let socket, requestId = 0;
const pending = new Map(), errors = [];
async function send(method, params = {}) {
  const id = ++requestId;
  return new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout ${method}`)); }, 15000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); });
}
async function evaluate(expression) { const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + ': ' + result.exceptionDetails.exception?.description); return result.result.value; }
async function until(expression, timeout = 12000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await evaluate(expression)) return; await pause(70); } throw new Error(`UI condition timed out: ${expression}`); }
const fill = (selector, value) => evaluate(`document.querySelector(${JSON.stringify(selector)}).value=${JSON.stringify(value)}`);
const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
async function page(name, selector) { await click(`[data-page="${name}"]`); await until(`!!document.querySelector(${JSON.stringify(selector)})`); }
let count = 0;
const ok = message => { count++; console.log(`OK  ${message}`); };
try {
  let tabs;
  for (let i = 0; i < 100; i++) { tabs = await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`).then(r => r.json()).catch(() => null); if (tabs?.length) break; await pause(100); }
  if (!tabs?.length) throw new Error('Headless browser did not open DevTools.');
  socket = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl); await once(socket, 'open');
  socket.addEventListener('message', event => { const message = JSON.parse(event.data); if (message.id) { const call = pending.get(message.id); if (call) { clearTimeout(call.timer); pending.delete(message.id); message.error ? call.reject(new Error(message.error.message)) : call.resolve(message.result); } } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text); });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/ui/#bootstrap=${auth.bootstrap}` });
  await until('document.querySelector("#auth-title")?.textContent.includes("Tạo mật khẩu")');
  assert.equal(await evaluate('location.hash'), '');
  await fill('#auth-password', 'browser-password-123456'); await fill('#auth-confirm', 'browser-password-123456'); await click('#auth-submit');
  await until('!document.querySelector("#shell").hidden && !!document.querySelector("#state-mcp")'); ok('bootstrap fragment cleared; first-use setup opens dashboard');
  const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); await fs.writeFile(path.join(scratch, 'overview.png'), Buffer.from(screenshot.data, 'base64'));
  await click('#theme'); assert.equal(await evaluate('document.documentElement.dataset.theme'), 'dark'); ok('light/dark toggle');
  await click('[data-target="mcp"][data-action="start"]'); await until('document.querySelector("#state-mcp")?.textContent.includes("running")');
  await click('[data-target="mcp"][data-action="stop"]'); await until('document.querySelector("#state-mcp")?.textContent.includes("stopped")'); ok('start/stop MCP from dashboard; panel remains usable');
  await page('cloudflare', '#cf-token'); await fill('#cf-token', 'browser_cloudflare_token_abcdefghijklmnopqrstuvwxyz'); await evaluate('document.querySelector("#cf-token-form").requestSubmit()');
  await until('document.querySelector("#cf-zone").options.length === 2'); await fill('#cf-zone', zoneId); await evaluate('document.querySelector("#cf-zone").dispatchEvent(new Event("change"))'); await until('document.querySelector("#cf-hostname").value === "mcp.example.com"'); await pause(300);
  await evaluate('document.querySelector("#cf-selection").requestSubmit()'); await until('!!document.querySelector("#cf-apply")'); assert.equal(mutations, 0); ok('Cloudflare wizard loads zone/tunnels; preview has no remote mutations');
  assert.equal(await evaluate('document.activeElement.id'), 'cf-preview'); ok('Preview moves focus to the visible Apply step');
  await click('#cf-apply'); await until('!!document.querySelector("#cf-last-error")'); assert.equal(mutations, 1);
  assert((await evaluate('document.querySelector("#cf-last-error").textContent')).includes('Cloudflare Tunnel → Edit')); ok('creation permission error is visible inline with stage and actionable help');
  await page('overview', '#state-mcp'); await page('cloudflare', '#cf-selection');
  await until('document.querySelector("#cf-zone").value === "' + zoneId + '" && !document.querySelector("#cf-tunnel").disabled');
  assert.equal(await evaluate('document.querySelector("#cf-hostname").value'), 'mcp.example.com'); assert.equal(await evaluate('document.querySelector("#cf-name").value'), 'chatgpt-local');
  assert((await evaluate('document.querySelector("#cf-last-error").textContent')).includes('HTTP 403'));
  await evaluate('document.querySelector("#cf-selection").requestSubmit()'); await until('document.activeElement.id === "cf-preview"'); assert.equal(mutations, 1); ok('saved token/form/error restore on reopening; preview resumes the failed plan without mutations');
  denyCreate = false;
  await click('#cf-apply'); await until('document.querySelector("#cf-current").textContent.includes("Đã cấu hình")'); assert.equal(mutations, 4); assert.equal(await evaluate('!!document.querySelector("#cf-last-error")'), false); ok('Retry provisions mocked tunnel, ingress and DNS and clears the saved error');
  await page('workspaces', '#workspace-create');
  assert.equal(await evaluate('document.querySelectorAll("[data-ws-edit]").length'), 2); ok('Workspaces view shows default and Blender runtimes');
  const blenderWorkspace = workspaces.list().find(w=>w.preset === 'blender');
  await click(`[data-ws-test="${blenderWorkspace.id}"]`); await until(`!!document.querySelector('[data-ws-result="${blenderWorkspace.id}"] .callout')`);
  assert((await evaluate(`document.querySelector('[data-ws-result="${blenderWorkspace.id}"]').textContent`)).includes('Khởi chạy MCP')); ok('Blender test errors remain visible on the workspace card');
  await fill('#workspace-create [name="name"]', 'Browser workspace'); await fill('#workspace-create [name="path"]', scratch); await evaluate('document.querySelector("#workspace-create").requestSubmit()');
  await until('document.querySelectorAll("[data-ws-edit]").length === 3');
  const created = workspaces.list().find(w=>w.name === 'Browser workspace'); assert(created);
  await click(`[data-workspace="${created.id}"][data-ws-action="start"]`); await until(`document.querySelector('[data-workspace-state="${created.id}"]').textContent.includes('running')`);
  await click(`[data-workspace="${created.id}"][data-ws-action="stop"]`); await until(`document.querySelector('[data-workspace-state="${created.id}"]').textContent.includes('stopped')`); ok('UI creates an independent workspace and controls its runtime');
  await click(`[data-ws-url="${created.id}"]`); await until('document.querySelector("#reauth-dialog").open'); await fill('#reauth-password', 'browser-password-123456'); await evaluate('document.querySelector("#reauth-form").requestSubmit()');
  await until(`!!document.querySelector('[data-ws-result="${created.id}"] input')`);
  assert.equal(await evaluate(`document.querySelector('[data-ws-result="${created.id}"] input').value`), `https://mcp.example.com/mcp/${workspaces.token(created.id)}`); ok('workspace URL is revealed only after password confirmation on the same hostname');
  await page('gpt', '#gpt-url'); assert((await evaluate('document.querySelector("#gpt-url").value')).includes('[hidden]')); await click('#reveal-gpt'); await until('document.querySelector("#reauth-dialog").open'); await fill('#reauth-password', 'browser-password-123456'); await evaluate('document.querySelector("#reauth-form").requestSubmit()'); await until('document.querySelector("#gpt-url").value.includes("ui_mcp_token_")'); ok('GPT URL is masked; password reauthentication reveals exact URL');
  await page('config', '#env-form'); assert.equal(await evaluate('document.querySelector("[data-env=MCP_TOKEN]").value'), '[hidden]'); await fill('#new-key', 'SHELL_TIMEOUT'); await fill('#new-value', '140'); await evaluate('document.querySelector("#env-form").requestSubmit()'); await until('document.querySelector("[data-env=SHELL_TIMEOUT]")?.value === "140"'); assert.equal((await config.values()).SHELL_TIMEOUT, '140'); ok('config edits persist; navigating away masks secrets');
  await page('upstream', '#edit-upstream'); for (const tab of ['import','plugins','hooks','tools']) { await click(`[data-up-tab="${tab}"]`); await until(`!!document.querySelector(${JSON.stringify({ import: '#import-form', plugins: '#save-plugins', hooks: '#save-hooks', tools: '#save-tools' }[tab])})`); } ok('upstream/import/plugins/hooks/tools views load without browser errors');
  await page('logs', '#log-filter'); await fill('#log-filter', 'nothing-matches'); await evaluate('document.querySelector("#log-filter").dispatchEvent(new Event("input"))'); await until('document.querySelector("#log-entries").textContent.includes("Chưa có")'); ok('live log filtering');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await page('overview', '#state-mcp'); assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true); ok('mobile viewport has no page overflow');
  await click('#logout'); await until('!document.querySelector("#auth-screen").hidden'); await fill('#auth-password', 'wrong'); await click('#auth-submit'); await until('document.querySelector("#auth-error").textContent.includes("không đúng")'); await fill('#auth-password', 'browser-password-123456'); await click('#auth-submit'); await until('!document.querySelector("#shell").hidden'); ok('logout, invalid password feedback and login');
  assert.deepEqual(errors, []); ok('no unhandled JavaScript exceptions');
} finally {
  socket?.close(); for (const call of pending.values()) clearTimeout(call.timer);
  if (browser.pid) { if (process.platform === 'win32') { const killer = spawn('taskkill.exe', ['/PID', String(browser.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); await once(killer, 'exit').catch(() => {}); } else browser.kill(); }
  controller.closeEvents(); await workspaces.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
console.log(`\n${count} browser checks passed. Screenshot: ${path.join(scratch, 'overview.png')}`);
