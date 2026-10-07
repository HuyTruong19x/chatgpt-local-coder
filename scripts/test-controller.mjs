import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');
const scratch = await fs.mkdtemp(path.join(root, '.tool-test-tmp/controller-'));
process.env.MCP_UPSTREAM_CONFIG = path.join(scratch, 'upstream.json');
process.env.AUDIT_LOG_PATH = path.join(scratch, 'audit.log');
await fs.writeFile(process.env.MCP_UPSTREAM_CONFIG, JSON.stringify({ version: 1, servers: [] }));
const { AdminAuth } = await import('../dist/controller/auth.js');
const { ConfigStore, atomicJson } = await import('../dist/controller/store.js');
const { Vault } = await import('../dist/controller/vault.js');
const { Cloudflare } = await import('../dist/controller/cloudflare.js');
const { Runtime } = await import('../dist/controller/runtime.js');
const { createController } = await import('../dist/controller/server.js');
const { toolAnnotations } = await import('../dist/lib/tool-annotations.js');
const { redact, redactText, rememberSecret } = await import('../dist/lib/redaction.js');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (test, timeout = 10000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (await test()) return; await pause(30); } throw new Error('Condition timed out'); };
const freePort = async () => { const socket = net.createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening'); const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port; };
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`OK  ${name}`); }
let clock = 1000;
const auth = new AdminAuth(path.join(scratch, 'auth-test.json'), () => clock);
const password = 'correct-password-123';
await auth.init();
await test('scrypt password hash; no plaintext password; bounds enforced', async () => {
  await assert.rejects(auth.setPassword('short'));
  await auth.setPassword(password); assert.equal(await auth.verify(password), true);
  assert.equal(await auth.verify('wrong'), false);
  assert.equal((await fs.readFile(auth.file, 'utf8')).includes(password), false);
});
await test('5 failed logins lock for 15 minutes; then allow recovery', async () => {
  for (let i = 0; i < 5; i++) await assert.rejects(auth.login('wrong'));
  await assert.rejects(auth.login(password), error => error.code === 'LOGIN_LOCKED');
  clock += 900001; await auth.login(password);
});
await test('reauthentication, idle/absolute expiry, password change revokes sessions', async () => {
  let session = await auth.login(password); assert.throws(() => auth.requireRecent(session));
  await auth.reauthenticate(session, password); auth.requireRecent(session);
  clock += 300001; assert.throws(() => auth.requireRecent(session));
  clock += 1800000; assert.equal(auth.valid(session), false);
  session = await auth.login(password); clock += 28800001; session.touched = clock; assert.equal(auth.valid(session), false);
  session = await auth.login(password); await auth.setPassword(password); assert.equal(auth.valid(session), false);
});
const config = new ConfigStore(scratch), mcpPort = await freePort(), adminPort = await freePort(), metricsPort = await freePort();
const token = 'test_mcp_token_abcdefghijklmnopqrstuvwxyz';
await config.save({ HOST: '127.0.0.1', PORT: String(mcpPort), ADMIN_PORT: String(adminPort), MCP_TOKEN: token, MCP_UPSTREAM_CONFIG: process.env.MCP_UPSTREAM_CONFIG, WORKSPACE_PATH: scratch, CLOUDFLARED_METRICS_PORT: String(metricsPort) });
await test('config preserves comments/unknown values and rejects unsafe inputs', async () => {
  await fs.appendFile(path.join(scratch, '.env'), '\n# Keep me\nUNKNOWN_VALUE="old"\n');
  await config.save({ UNKNOWN_VALUE: 'new' });
  assert.match(await fs.readFile(path.join(scratch, '.env'), 'utf8'), /# Keep me/);
  await Promise.all([config.save({ PATH_VALUE: String.raw`D:\new\repo` }), config.save({ QUOTED_VALUE: `{"message":"it's valid"}` })]);
  const persisted = await config.values(); assert.equal(persisted.PATH_VALUE, String.raw`D:\new\repo`); assert.equal(persisted.QUOTED_VALUE, `{"message":"it's valid"}`);
  for (const patch of [{ HOST: '0.0.0.0' }, { PORT: '12' }, { MCP_TOKEN: 'short' }, { NODE_OPTIONS: '--eval=bad' }, { NEW_VALUE: 'a\nb' }]) await assert.rejects(config.save(patch));
});
const protector = async (value, decrypt) => decrypt ? Buffer.from(value, 'base64').toString() : Buffer.from(value).toString('base64');
const vault = new Vault(path.join(scratch, 'vault-mock.json'), protector); await vault.init(); await vault.save({ apiToken: 'CF_API_TOKEN_abcdefghijklmnopqrstuvwxyz', tunnelToken: 'CF_TUNNEL_TOKEN_abcdefghijklmnopqrstuvwxyz' });
if (process.platform === 'win32') await test('real Windows DPAPI vault roundtrip without plaintext on disk', async () => {
  const first = new Vault(path.join(scratch, 'vault-real.json')); await first.init(); await first.save({ apiToken: 'roundtrip-private-secret-123456' });
  assert.equal((await fs.readFile(first.file, 'utf8')).includes('roundtrip-private'), false);
  const second = new Vault(first.file); await second.init(); assert.equal(second.get('apiToken'), 'roundtrip-private-secret-123456');
});
await test('redaction masks known secrets, headers, command arguments and token paths', async () => {
  rememberSecret('a-private-key-12345');
  const value = redact({ command: 'curl -H "a-private-key-12345" /mcp/' + token, headers: { Authorization: 'Bearer opaquevalue' }, env: { MY_PASSWORD: '12345' } });
  assert.equal(JSON.stringify(value).includes(token), false); assert.equal(value.headers.Authorization, '[hidden]'); assert.equal(value.env.MY_PASSWORD, '[hidden]');
  const command = redactText('NEW_API_KEY=unknownCredential curl -H "Authorization: Bearer anotherUnknown" --token thirdUnknown');
  for (const secret of ['unknownCredential', 'anotherUnknown', 'thirdUnknown']) assert.equal(command.includes(secret), false);
  assert.equal(redact({ authorization_url: 'https://provider.example/authorize?state=flow' }).authorization_url, 'https://provider.example/authorize?state=flow');
  process.env.CHATGPT_AUTO_APPROVE = 'true'; assert.equal(toolAnnotations('command').destructiveHint, true); assert.equal(toolAnnotations('command').openWorldHint, true);
});
const accountId = 'a'.repeat(32), zoneId = 'b'.repeat(32), tunnelId = '12345678-1234-1234-1234-123456789012';
let dns = [], ingress = [{ hostname: 'existing.example.com', service: 'http://localhost:8888' }, { service: 'http_status:404' }], tunnels = [], createCount = 0, failDns = true, rateLimit = false, zoneActive = true, denyCreate = true, loseCreateResponse = false;
const apiCalls = [];
const mock = async (url, init = {}) => {
  const route = new URL(url).pathname.replace('/client/v4', ''), method = init.method || 'GET'; apiCalls.push({ route, method });
  let result = null;
  if (rateLimit) return new Response(JSON.stringify({ success: false }), { status: 429, headers: { 'Retry-After': '3' } });
  if (route === '/user/tokens/verify') result = { status: 'active' };
  else if (route === '/zones' || route === `/zones/${zoneId}`) { const zone = { id: zoneId, name: 'example.com', status: zoneActive ? 'active' : 'pending', account: { id: accountId, name: 'My Account' }, name_servers: ['one.ns.cloudflare.com'] }; result = route === '/zones' ? [zone] : zone; }
  else if (route.endsWith('/cfd_tunnel')) {
    if (method === 'POST' && denyCreate) return Response.json({ success: false, errors: [{ code: 10000, message: `Forbidden CF_API_TOKEN_abcdefghijklmnopqrstuvwxyz` }] }, { status: 403 });
    if (method === 'POST') { createCount++; tunnels.push({ id: tunnelId, name: JSON.parse(init.body).name, config_src: 'cloudflare' }); result = tunnels[0]; } else result = tunnels;
    if (method === 'POST' && loseCreateResponse) throw new Error('Injected lost create response');
  } else if (route.endsWith('/token')) result = 'CF_REAL_TUNNEL_abcdefghijklmnopqrstuvwxyz';
  else if (route.endsWith('/configurations')) { if (method === 'PUT') ingress = JSON.parse(init.body).config.ingress; result = { config: { ingress, originRequest: { connectTimeout: 30 } } }; }
  else if (route.endsWith('/dns_records')) { if (method === 'POST') { if (failDns) throw new Error('Injected DNS failure'); dns = [{ ...JSON.parse(init.body), id: 'record-id' }]; } result = dns; }
  else throw new Error(`Unexpected Cloudflare API ${route}`);
  return Response.json({ success: true, result });
};
const cf = new Cloudflare(config, vault, mock);
const selection = { accountId, zoneId, hostname: 'mcp.example.com', name: 'chatgpt-test' };
await test('token verification and pending domain guard', async () => {
  assert.equal((await cf.connect('CF_API_TOKEN_abcdefghijklmnopqrstuvwxyz')).length, 1);
  zoneActive = false; await assert.rejects(cf.preview(selection), error => error.code === 'CF_ZONE_PENDING'); zoneActive = true;
});
await test('preview performs no remote mutations; refuses DNS conflicts', async () => {
  dns = [{ type: 'A', content: '10.0.0.1' }]; await assert.rejects(cf.preview(selection), error => error.code === 'CF_DNS_CONFLICT'); dns = [];
  apiCalls.length = 0; await cf.preview(selection); assert(apiCalls.every(c => c.method === 'GET'));
});
await test('failed creation persists stage/error without secrets; same preview resumes after reload', async () => {
  const plan = await cf.preview(selection);
  await assert.rejects(cf.apply(plan.id), error => error.code === 'CF_PERMISSION' && error.httpStatus === 403 && /10000/.test(error.message));
  const journal = JSON.parse(await fs.readFile(path.join(config.stateDir, 'cloudflare-plan.json'), 'utf8'));
  assert.equal(journal.lastError.stage, 'Tạo tunnel'); assert.equal(journal.lastError.httpStatus, 403); assert.match(journal.lastError.message, /Cloudflare Tunnel → Edit/);
  assert.equal(JSON.stringify(journal).includes(vault.get('apiToken')), false); assert.equal(journal.tunnelId, undefined); assert.equal(createCount, 0);
  const restarted = new Cloudflare(config, vault, mock); apiCalls.length = 0;
  const resumed = await restarted.preview({ ...selection, hostname: ' MCP.EXAMPLE.COM ' });
  assert.equal(resumed.id, plan.id); assert.equal(apiCalls.length, 0);
  await assert.rejects(restarted.preview({ ...selection, hostname: 'other.example.com' }), error => error.code === 'CF_SETUP_UNFINISHED');
  denyCreate = false;
});
await test('partial apply journals created ID; retry reuses tunnel and preserves other ingress', async () => {
  const plan = await cf.preview(selection); await assert.rejects(cf.apply(plan.id), /Injected DNS failure/);
  const failed = JSON.parse(await fs.readFile(path.join(config.stateDir, 'cloudflare-plan.json'), 'utf8'));
  assert.equal(failed.lastError.stage, 'Cấu hình DNS'); assert.equal(failed.lastError.code, 'CF_NETWORK');
  assert.equal((await cf.preview(selection)).id, plan.id);
  failDns = false; const result = await cf.apply(plan.id); assert.equal(result.complete, true); assert.equal(createCount, 1);
  assert.equal(result.lastError, undefined);
  assert(ingress.some(r => r.hostname === 'existing.example.com')); assert.equal(ingress.at(-1).service, 'http_status:404');
  const rule = ingress.find(r => r.hostname === selection.hostname); assert.equal(rule.service, `http://127.0.0.1:${mcpPort}`); assert.match(rule.path, /mcp/); assert.equal(dns[0].proxied, true);
  await cf.apply(plan.id); assert.equal(createCount, 1); assert.equal(dns.length, 1);
});
await test('lost create response resumes by name without creating a duplicate tunnel', async () => {
  dns = []; tunnels = []; ingress = []; loseCreateResponse = true;
  const plan = await cf.preview(selection), before = createCount;
  await assert.rejects(cf.apply(plan.id), error => error.code === 'CF_NETWORK');
  assert.equal(createCount, before + 1);
  const restarted = new Cloudflare(config, vault, mock), resumed = await restarted.preview(selection);
  assert.equal(resumed.id, plan.id); assert.equal(resumed.tunnelId, undefined);
  loseCreateResponse = false; const result = await restarted.apply(resumed.id);
  assert.equal(result.complete, true); assert.equal(createCount, before + 1); assert.equal(result.lastError, undefined);
});
await test('Cloudflare 429 propagates Retry-After and does not mutate', async () => {
  rateLimit = true; await assert.rejects(cf.zones(), error => error.code === 'CF_RATE_LIMIT' && error.retryAfter === '3'); rateLimit = false;
  const before = apiCalls.length; await assert.rejects(cf.zones(), error => error.code === 'CF_RATE_LIMIT'); assert.equal(apiCalls.length, before);
  const forbidden = new Cloudflare(config, vault, async () => Response.json({ success: false, errors: [{ message: 'Forbidden' }] }, { status: 403 }));
  await assert.rejects(forbidden.zones(), error => error.code === 'CF_PERMISSION');
});
if (process.platform === 'win32') await test('official cloudflared download checks SHA256 before install', async () => {
  const binary = Buffer.from('fixture-binary-not-executed'); const digest = createHash('sha256').update(binary).digest('hex');
  let expected = '0'.repeat(64);
  const downloads = new Cloudflare(config, vault, async url => url.includes('api.github.com') ? Response.json({ tag_name: 'test', assets: [{ name: 'cloudflared-windows-amd64.exe', digest: `sha256:${expected}`, browser_download_url: 'https://github.com/cloudflare/cloudflared/releases/download/test/cloudflared-windows-amd64.exe' }] }) : new Response(binary));
  await assert.rejects(downloads.install(), /SHA256/); expected = digest; await downloads.install(); assert.deepEqual(await fs.readFile(path.join(scratch, 'bin/cloudflared.exe')), binary);
});
await fs.cp(path.join(root, 'public/controller'), path.join(scratch, 'public/controller'), { recursive: true });
const realAuth = new AdminAuth(path.join(scratch, 'admin.json')); await realAuth.init();
const runtime = new Runtime(config, vault, path.join(root, 'dist/index.js'));
const controller = await createController({ config, auth: realAuth, vault, runtime, cloudflare: cf, port: adminPort });
const server = controller.app.listen(adminPort, '127.0.0.1'); await once(server, 'listening');
const base = `http://127.0.0.1:${adminPort}`;
let cookie = '', csrf = '';
async function request(route, method = 'GET', body, overrides = {}) {
  return fetch(base + route, { method, headers: { Origin: base, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...overrides }, body: body === undefined ? undefined : JSON.stringify(body) });
}
try {
  await test('admin config private before login; static login loads with CSP', async () => {
    assert.equal((await request('/api/config/env')).status, 401);
    const ui = await request('/ui/'); assert.match(ui.headers.get('content-security-policy'), /frame-ancestors 'none'/); assert.match(await ui.text(), /auth-password/);
  });
  await test('bootstrap rejects missing nonce; single use setup establishes HttpOnly session', async () => {
    assert.equal((await request('/api/auth/setup', 'POST', { password })).status, 403);
    const response = await request('/api/auth/setup', 'POST', { password, nonce: realAuth.bootstrap }); assert.equal(response.status, 200);
    cookie = response.headers.get('set-cookie').split(';')[0]; assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/); csrf = (await response.json()).csrf;
    assert.equal((await request('/api/auth/setup', 'POST', { password, nonce: realAuth.bootstrap })).status, 403);
  });
  await test('host/origin/CSRF protections reject spoofed and cross-site mutations', async () => {
    const spoofed = await new Promise(resolve => { const q = http.get(base + '/api/status', { headers: { Host: 'evil.test' } }, res => { res.resume(); resolve(res.statusCode); }); q.on('error', error => { throw error; }); });
    assert.equal(spoofed, 403);
    assert.equal((await request('/api/lifecycle', 'POST', { target: 'all', action: 'start' }, { Origin: 'https://evil.test' })).status, 403);
    assert.equal((await request('/api/lifecycle', 'POST', {}, { 'X-CSRF-Token': '' })).status, 403);
    assert.equal((await request('/api/auth/login', 'POST', { password }, { Origin: '' })).status, 403);
  });
  await test('secret configs masked; full view requires recent password', async () => {
    const masked = await (await request('/api/config/env')).json(); assert.equal(masked.values.MCP_TOKEN, '[hidden]');
    assert.equal((await request('/api/gpt?reveal=1')).status, 403);
    assert.equal((await request('/api/auth/reauth', 'POST', { password })).status, 200);
    const full = await (await request('/api/gpt?reveal=1')).json(); assert.equal(full.serverUrl, `https://mcp.example.com/mcp/${token}`);
  });
  await test('offline upstream accessible through reusable router, live actions require MCP', async () => {
    assert.equal((await request('/api/upstream')).status, 200);
    assert.equal((await request('/api/upstream/unknown/tools')).status, 409);
  });
  await test('MCP child runs without extra admin listener and public health leaks no token/path', async () => {
    await runtime.request('mcp', 'start');
    const health = await (await fetch(`http://127.0.0.1:${mcpPort}/health`)).json(); assert.deepEqual(Object.keys(health).sort(), ['name', 'status']);
    assert.equal((await fetch(`http://127.0.0.1:${mcpPort}/mcp`)).status, 404);
    const invalid = await fetch(`http://127.0.0.1:${mcpPort}/mcp/${token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad-json' });
    assert.equal(invalid.status, 400); assert.deepEqual(await invalid.json(), { error: 'Invalid request' });
    assert.equal((await fetch(`http://127.0.0.1:${mcpPort}/mcp/${token}`, { headers: { Origin: 'https://evil.test' } })).status, 403);
    const result = await runtime.rpc('GET', '/api/instructions/preview'); assert.equal(result.status, 200); assert(result.data.preview.includes('Agent workflow'));
    const upstream = await runtime.rpc('GET', '/api/upstream'); assert.equal(upstream.status, 200);
  });
  await test('IPC handles params/errors, SSE relays activity, stop keeps admin alive', async () => {
    const result = await runtime.rpc('POST', '/api/upstream/unknown/test', {}); assert.equal(result.status, 400); assert.match(result.data.error, /Unknown upstream/);
    let activity = false; runtime.once('activity', () => { activity = true; });
    const clientModule = await import('@modelcontextprotocol/sdk/client/index.js'); const transportModule = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const client = new clientModule.Client({ name: 'controller-test', version: '1' }); const transport = new transportModule.StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpPort}/mcp/${token}`));
    await client.connect(transport); assert((await client.listTools()).tools.length > 0); await until(() => activity); await transport.terminateSession(); await client.close();
    await runtime.request('mcp', 'stop'); assert.equal((await request('/api/status')).status, 200); assert.equal(runtime.snapshot().mcp.state, 'stopped');
    assert.equal(JSON.stringify((await (await request('/api/logs')).json())).includes(token), false);
  });
  await test('logout and password change revoke session; re-login works', async () => {
    assert.equal((await request('/api/auth/logout', 'POST', {})).status, 200); assert.equal((await request('/api/status')).status, 401);
    const login = await request('/api/auth/login', 'POST', { password }); cookie = login.headers.get('set-cookie').split(';')[0]; csrf = (await login.json()).csrf;
    assert.equal((await request('/api/auth/password', 'POST', { currentPassword: password, password: 'new-password-123456' })).status, 200);
    assert.equal((await request('/api/status')).status, 401);
  });
} finally { controller.closeEvents(); await runtime.close(); await new Promise(resolve => server.close(resolve)); }

const fakeMcp = path.join(scratch, 'fake-mcp.mjs');
await fs.writeFile(fakeMcp, `import http from 'node:http'; const s=http.createServer((q,r)=>r.end('{}')).listen(+process.env.PORT,'127.0.0.1'); process.on('message',m=>{if(m.type==='shutdown')process.exit(0)}); if(process.env.FAKE_CRASH_LOOP==='true') setTimeout(()=>process.exit(9),300);`);
const fakeTunnel = path.join(scratch, 'fake-tunnel.mjs');
await fs.writeFile(fakeTunnel, `import http from 'node:http'; const p=process.argv[process.argv.indexOf('--metrics')+1].split(':').at(-1); http.createServer((q,r)=>r.end('ready')).listen(+p,'127.0.0.1');`);
await config.save({ CLOUDFLARED_PATH: fakeTunnel }); // The injected spawn runs this fixture with Node.
let launchArgs;
const managed = new Runtime(config, vault, fakeMcp, [50, 100, 150], { fork, spawn: (_file, args, options) => { launchArgs = { args, env: options.env }; return spawn(process.execPath, [fakeTunnel, ...args], options); } });
try {
  await test('Start all orders MCP then tunnel; token passed in env not args; stop all reverses', async () => {
    process.env.MCP_TOKEN = token;
    await managed.request('all', 'start'); assert.equal(managed.snapshot().mcp.state, 'running'); assert.equal(managed.snapshot().tunnel.state, 'connected');
    assert(!launchArgs.args.join(' ').includes(vault.get('tunnelToken'))); assert.equal(launchArgs.env.TUNNEL_TOKEN, vault.get('tunnelToken'));
    assert.equal(launchArgs.env.MCP_TOKEN, undefined);
    await managed.request('all', 'stop'); assert.equal(managed.snapshot().tunnel.state, 'stopped'); assert.equal(managed.snapshot().mcp.state, 'stopped');
  });
  await test('port collision does not terminate owner; Stop cancels pending recovery', async () => {
    const owner = net.createServer().listen(mcpPort, '127.0.0.1'); await once(owner, 'listening');
    await assert.rejects(managed.request('mcp', 'start'), error => error.code === 'PORT_BUSY'); await managed.request('all', 'stop'); await pause(200); assert.equal(owner.listening, true); await new Promise(resolve => owner.close(resolve));
  });
  await test('crash recovery is bounded to three retries and Stop prevents restart', async () => {
    await config.save({ FAKE_CRASH_LOOP: 'true' }); await managed.request('mcp', 'start');
    await until(() => managed.snapshot().mcp.retries === 3 && managed.snapshot().mcp.state === 'error', 8000); await pause(600); assert.equal(managed.snapshot().mcp.retries, 3); assert.equal(managed.snapshot().mcp.pid, undefined);
    await managed.request('all', 'stop'); await pause(250); assert.equal(managed.snapshot().mcp.state, 'stopped');
  });
} finally { await managed.close(); }
console.log(`\n${passed} controller checks passed. Fixtures: ${scratch}`);
