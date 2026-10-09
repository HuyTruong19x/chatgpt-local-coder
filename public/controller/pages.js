import { api as request, operation } from './api.js';
import { $, escape as e, bind, badge, head, empty, notice } from './ui.js';
export const titles = { overview: 'Tổng quan', workspaces: 'Workspaces', cloudflare: 'Cloudflare Tunnel', gpt: 'Kết nối GPT', config: 'Cấu hình', upstream: 'MCP & công cụ', logs: 'Nhật ký' };
let page = 'overview', reauth, state, envOriginal, revealedAt = 0;
let viewEpoch = 0;
async function api(url, method = 'GET', body) {
  const epoch = viewEpoch;
  const value = await request(url, method, body);
  if (method === 'GET' && epoch !== viewEpoch) throw Object.assign(new Error('View changed'), { code: 'STALE_VIEW' });
  return value;
}
export function currentPage() { return page; }
export function forgetSecrets() { envOriginal = null; revealedAt = 0; }
const content = () => $('#content');
const lifecycle = async (target, action) => { notice('Đang xử lý…'); await operation('/api/lifecycle', { target, action }); notice('Đã hoàn tất'); if (page === 'overview') await render('overview'); };
export async function render(name, verify) {
  const epoch = ++viewEpoch;
  page = titles[name] ? name : 'overview'; if (verify) reauth = verify;
  document.querySelectorAll('[data-page]').forEach(node => { node.classList.toggle('active', node.dataset.page === page); node.setAttribute('aria-current', node.dataset.page === page ? 'page' : 'false'); });
  $('#breadcrumb').textContent = `Workspace / ${titles[page]}`;
  content().innerHTML = empty('Đang tải…');
  try { await ({ overview, workspaces, cloudflare, gpt, config, upstream, logs })[page](); }
  catch (error) { if (epoch !== viewEpoch || error.code === 'STALE_VIEW') return; content().innerHTML = head(titles[page], 'Không tải được dữ liệu') + `<div class="callout">${e(error.message)}</div><button id="retry-page">Thử lại</button>`; bind('#retry-page', () => render(page)); }
}
export function refreshStatus(value) {
  state = value;
  if (page === 'workspaces') {
    for (const workspace of value.workspaces || []) {
      const node = $(`[data-workspace-state="${workspace.id}"]`); if (node) node.innerHTML = badge(workspace.state);
      const detail = $(`[data-workspace-detail="${workspace.id}"]`); if (detail) detail.textContent = workspace.error || (workspace.pid ? `PID ${workspace.pid}` : 'Chưa khởi chạy');
    }
  }
  if (page !== 'overview') return;
  for (const name of ['mcp', 'tunnel']) {
    const node = $(`#state-${name}`); if (node) node.innerHTML = badge(value[name].state);
    const detail = $(`#detail-${name}`); if (detail) detail.textContent = value[name].error || (value[name].pid ? `PID ${value[name].pid} · Khôi phục ${value[name].retries}/3` : 'Chưa khởi chạy');
  }
}
async function workspaces() {
  const epoch = viewEpoch, data = await api('/api/workspaces');
  content().innerHTML = head('Nhiều dự án, cùng một domain', 'Mỗi token kết nối tới đúng workspace. Khởi chạy và dừng từng dự án độc lập.', '<button id="refresh-workspaces">↻ Làm mới</button>') +
    `<div class="callout">${data.hostname ? `Domain chung: ${e(data.hostname)}.` : 'Hoàn tất Cloudflare Tunnel để lấy URL HTTPS.'} Mỗi workspace có token riêng. Trang Cấu hình và MCP & công cụ hiện quản lý workspace mặc định; chỉnh upstream của các workspace khác ngay bên dưới.</div>` +
    `<div class="grid two">${data.workspaces.map(w => `<article class="card"><div class="card-head"><h2>${e(w.name)}</h2><span data-workspace-state="${e(w.id)}">${badge(w.state)}</span></div><p><code>${e(w.path)}</code></p><p class="muted">${w.preset === 'blender' ? 'Blender MCP' : 'Coding MCP'} · Cổng nội bộ ${w.port}</p><p data-workspace-detail="${e(w.id)}">${e(w.error || (w.pid ? `PID ${w.pid}` : 'Chưa khởi chạy'))}</p><div class="actions">${['start','stop','restart'].map((action, i) => `<button data-workspace="${e(w.id)}" data-ws-action="${action}">${['Chạy','Dừng','Khởi động lại'][i]}</button>`).join('')}</div><div class="actions"><button data-ws-url="${e(w.id)}">Xem / copy URL</button><button data-ws-config="${e(w.id)}">Cấu hình MCP</button>${w.preset === 'blender' ? `<button data-ws-test="${e(w.id)}">Kiểm tra Blender MCP</button>` : ''}</div><div data-ws-result="${e(w.id)}" hidden></div><form data-ws-edit="${e(w.id)}"><label>Tên workspace<input name="name" value="${e(w.name)}" required maxlength="80"></label><label>Thư mục dự án<input name="path" value="${e(w.path)}" required></label><label class="check"><input name="autoStart" type="checkbox" ${w.autoStart ? 'checked' : ''}> Tự chạy khi mở ứng dụng</label><button type="submit">Lưu (dừng workspace trước)</button></form></article>`).join('')}</div>` +
    `<div class="card"><h2>Thêm workspace</h2><form id="workspace-create"><div class="field-row"><label>Tên<input name="name" required maxlength="80" placeholder="Dự án mới"></label><label>Thư mục dự án có sẵn<input name="path" required placeholder="D:\\Projects\\MyProject"></label></div><label>Loại MCP<select name="preset"><option value="coding">Coding</option><option value="blender">Blender</option></select></label><button class="primary" type="submit">Tạo workspace & token</button></form></div>` +
    `<div class="card"><h2>Kết nối add-on Blender đã có</h2><ol><li>Mở Blender, bật add-on MCP và khởi chạy socket server. Với Blender Lab, bật Allow Online Access trong Preferences → System → Network. Sau khi đổi cổng add-on, Stop rồi Start để áp dụng.</li><li>Chọn bridge khớp với add-on trong Cấu hình MCP: preset <code>uvx mcp-for-blender</code> dành cho ahujasid, dùng <code>BLENDER_HOST / BLENDER_PORT</code>. Blender Lab dùng source local: <code>uvx --from &lt;đường dẫn repo&gt;/mcp blender-mcp</code>, với <code>BLENDER_MCP_HOST / BLENDER_MCP_PORT</code>.</li><li>Cổng socket add-on phải khác cổng HTTP của bridge. Blender Lab dùng <code>--port</code> cho HTTP; cổng add-on dùng <code>BLENDER_MCP_PORT</code>. Với tool CLI, đặt <code>BLENDER_PATH</code> thành đường dẫn đầy đủ tới Blender executable nếu chưa có trong PATH.</li><li>Chọn đúng thư mục dự án Blender, bấm Chạy rồi Kiểm tra Blender MCP.</li><li>Copy URL của workspace Blender để kết nối qua cùng domain. Gọi tool đúng tên trong danh sách; Blender Lab có <code>blender__get_blendfile_summary_datablocks</code>, không có <code>blender__get_addon_status</code>.</li></ol><p class="muted">Preset ahujasid tắt telemetry của bridge bằng DISABLE_TELEMETRY=true. Add-on Blender giữ ở local.</p><a href="https://github.com/ahujasid/mcp-for-blender" target="_blank" rel="noreferrer">Hướng dẫn ahujasid ↗</a> · <a href="https://www.blender.org/lab/mcp-server/" target="_blank" rel="noreferrer">Hướng dẫn Blender Lab ↗</a></div>`;
  bind('#refresh-workspaces', () => render('workspaces'));
  bind('[data-ws-action]', async (_, node) => { await operation(`/api/workspaces/${node.dataset.workspace}/lifecycle`, { action: node.dataset.wsAction }); if (epoch === viewEpoch) await render('workspaces'); });
  bind('#workspace-create', async (_, form) => { const input = new FormData(form); await api('/api/workspaces', 'POST', Object.fromEntries(input)); if (epoch === viewEpoch) await render('workspaces'); }, 'submit');
  bind('[data-ws-edit]', async (_, form) => { const input = new FormData(form); await api(`/api/workspaces/${form.dataset.wsEdit}`, 'PUT', { name: input.get('name'), path: input.get('path'), autoStart: input.has('autoStart') }); if (epoch === viewEpoch) await render('workspaces'); notice('Đã lưu workspace'); }, 'submit');
  bind('[data-ws-url]', async (_, node) => {
    await reauth(); revealedAt = Date.now(); const id = node.dataset.wsUrl, result = await api(`/api/workspaces/${id}/connection?reveal=1`);
    if (epoch !== viewEpoch) return;
    const box = $(`[data-ws-result="${id}"]`); box.hidden = false;
    box.innerHTML = `<label>Server URL ${result.serverUrl ? 'HTTPS' : 'local (chưa setup Cloudflare)'}</label><div class="url-field"><input readonly value="${e(result.serverUrl || result.localUrl)}"><button data-copy-ws="${id}">Copy URL</button></div><p>Authentication: No authentication</p>`;
    bind(`[data-copy-ws="${id}"]`, async () => { await reauth(); const fresh = await api(`/api/workspaces/${id}/connection?reveal=1`); await navigator.clipboard.writeText(fresh.serverUrl || fresh.localUrl); notice('Đã copy URL workspace'); });
  });
  bind('[data-ws-config]', async (_, node) => {
    await reauth(); revealedAt = Date.now(); const id = node.dataset.wsConfig, result = await api(`/api/workspaces/${id}/upstream?reveal=1`);
    if (epoch !== viewEpoch) return;
    const box = $(`[data-ws-result="${id}"]`); box.hidden = false;
    box.innerHTML = `<label>MCP upstream của workspace</label><textarea class="editor" data-ws-json="${id}">${e(JSON.stringify(result.config, null, 2))}</textarea><button data-ws-save="${id}">Lưu cấu hình MCP</button>`;
    bind(`[data-ws-save="${id}"]`, async () => { await reauth(); await api(`/api/workspaces/${id}/upstream`, 'PUT', { config: JSON.parse($(`[data-ws-json="${id}"]`).value) }); notice('Đã lưu. Mở phiên MCP mới để cập nhật công cụ.'); });
  });
  bind('[data-ws-test]', async (_, node) => {
    const id = node.dataset.wsTest;
    try {
      const result = await operation(`/api/workspaces/${id}/upstream/blender/test`, {});
      if (epoch !== viewEpoch) return;
      const box = $(`[data-ws-result="${id}"]`); box.hidden = false; box.innerHTML = `<pre>${e(JSON.stringify(result, null, 2))}</pre>`;
    } catch (error) {
      if (epoch === viewEpoch) { const box = $(`[data-ws-result="${id}"]`); box.hidden = false; box.innerHTML = `<div class="callout warning">${e(error.message)}</div>`; }
      throw error;
    }
  });
}
async function overview() {
  state = await api('/api/status');
  const cf = state.cloudflare;
  content().innerHTML = head('Mọi thứ trong tầm kiểm soát', 'Khởi chạy, thiết lập và theo dõi kết nối GPT trên máy của bạn.', '<button id="refresh-overview">↻ Làm mới</button>') +
    `<div class="hero"><div><p class="eyebrow">WORKSPACE SẴN SÀNG</p><h2>Một panel. Toàn bộ kết nối.</h2><p>${cf?.complete ? `Domain ${e(cf.hostname)} đã được thiết lập. Khởi chạy để GPT truy cập MCP.` : 'Bắt đầu với Cloudflare Tunnel để có địa chỉ HTTPS cố định trên domain của bạn.'}</p></div><button class="primary" data-go="${cf?.complete ? 'gpt' : 'cloudflare'}">${cf?.complete ? 'Xem setup GPT ↗' : 'Thiết lập Cloudflare →'}</button></div>` +
    `<div class="grid">${['mcp','tunnel'].map(name => `<article class="card"><div class="card-head"><h2>${name === 'mcp' ? 'MCP Server' : 'Cloudflare Tunnel'}</h2><span id="state-${name}">${badge(state[name].state)}</span></div><div class="metric">${name === 'mcp' ? 'Local runtime' : 'Public connection'}</div><p class="status-detail" id="detail-${name}">${e(state[name].error || (state[name].pid ? `PID ${state[name].pid} · Khôi phục ${state[name].retries}/3` : 'Chưa khởi chạy'))}</p><div class="actions"><button data-target="${name}" data-action="start">Chạy</button><button data-target="${name}" data-action="stop">Dừng</button><button data-target="${name}" data-action="restart">Khởi động lại</button></div></article>`).join('')}<article class="card"><div class="card-head"><h2>Domain</h2>${badge(cf?.complete ? 'active' : 'chưa setup')}</div><div class="metric">${e(cf?.hostname || 'Chưa cấu hình')}</div><p class="status-detail">HTTPS qua Cloudflare · Admin chỉ local</p><div class="actions"><button data-go="cloudflare">Quản lý domain →</button></div></article></div>` +
    `<div class="card"><div class="card-head"><h2>Điều khiển ứng dụng</h2>${state.configPending ? badge('Cấu hình chờ restart') : badge('Đã đồng bộ')}</div><p class="muted">Chạy tất cả sẽ chờ MCP sẵn sàng rồi mở tunnel. Dừng tất cả vẫn giữ panel này hoạt động.</p><div class="actions"><button class="primary" data-target="all" data-action="start">▶ Chạy tất cả</button><button data-target="all" data-action="stop">■ Dừng tất cả</button><button data-target="all" data-action="restart">↻ Khởi động lại tất cả</button><button class="danger" id="exit-app">Thoát ứng dụng</button></div><label class="check"><input id="auto-start" type="checkbox" ${state.autoStart ? 'checked' : ''}> Tự chạy MCP và tunnel khi mở launcher</label></div>` +
    `<div class="grid two"><article class="card"><p class="eyebrow">01 / KẾT NỐI</p><h2>Setup trên GPT</h2><p class="muted">URL chính xác, chế độ xác thực và kiểm tra kết nối trước khi thêm app.</p><button data-go="gpt">Mở hướng dẫn →</button></article><article class="card"><p class="eyebrow">02 / CẤU HÌNH</p><h2>Lưu và đối chiếu cấu hình</h2><p class="muted">Xem giá trị đã lưu, giá trị đang chạy và MCP upstream trong một chỗ.</p><button data-go="config">Mở cấu hình →</button></article></div>`;
  bind('[data-go]', (_, node) => render(node.dataset.go));
  bind('[data-target]', (_, node) => lifecycle(node.dataset.target, node.dataset.action));
  bind('#refresh-overview', () => render('overview'));
  bind('#auto-start', async (_, node) => { await api('/api/config/env', 'PUT', { values: { CONTROLLER_AUTOSTART: String(node.checked) } }); notice('Đã lưu tùy chọn launcher'); }, 'change');
  bind('#exit-app', async () => { if (!confirm('Dừng MCP, tunnel và đóng controller?')) return; await api('/api/exit', 'POST', {}); notice('Ứng dụng đã dừng. Mở launcher để chạy lại.'); });
}
async function cloudflare() {
  const epoch = viewEpoch;
  const cf = await api('/api/cloudflare');
  content().innerHTML = head('Địa chỉ cố định cho MCP', 'Kết nối domain đã mua với Cloudflare Tunnel, không cần port forwarding.') +
    `<div class="steps"><div class="step ${cf.tokenConfigured ? 'done' : ''}"><b>1</b> API token</div><div class="step"><b>2</b> Domain & tunnel</div><div class="step"><b>3</b> Xem trước</div><div class="step ${cf.current?.complete ? 'done' : ''}"><b>4</b> Áp dụng & chạy</div></div>` +
    `<div class="grid two"><div class="card"><h2>1. Kết nối Cloudflare</h2><p class="muted">Tạo API token giới hạn trong account và zone cần dùng.</p><div class="callout">Quyền: Account → Cloudflare Tunnel → Edit; Zone → Zone → Read; Zone → DNS → Edit.</div><form id="cf-token-form"><label for="cf-token">Cloudflare API token</label><input id="cf-token" type="password" autocomplete="off" placeholder="${cf.tokenConfigured ? 'Đã lưu trong vault Windows' : 'Dán API token của bạn'}" required><div class="actions"><button class="primary" type="submit">Lưu & kiểm tra</button><button type="button" id="load-zones" ${cf.tokenConfigured ? '' : 'disabled'}>Dùng token đã lưu</button></div></form><p class="muted">Token được mã hóa bằng DPAPI của tài khoản Windows hiện tại.</p><a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noreferrer">Tạo API token ↗</a></div><div class="card"><h2>2. Chọn domain & tunnel</h2><form id="cf-selection"><label for="cf-zone">Domain / account</label><select id="cf-zone" required><option value="">Kết nối token để tải domain</option></select><p id="zone-info" class="muted"></p><label for="cf-hostname">Hostname công khai</label><input id="cf-hostname" placeholder="mcp.example.com" required><label for="cf-tunnel">Tunnel</label><select id="cf-tunnel"><option value="">Tạo tunnel mới</option></select><label for="cf-name">Tên tunnel</label><input id="cf-name" value="chatgpt-local" required maxlength="64"><div class="actions"><button class="primary" type="submit">Xem trước thay đổi →</button></div></form></div></div>` +
    `<div id="cf-error" class="callout warning" role="alert" hidden></div><div class="card" id="cf-preview" tabindex="-1"><h2>3. Xem trước thay đổi</h2>${empty('Chọn domain và tunnel để xem DNS và ingress sẽ được tạo.')}</div><div class="card"><div class="card-head"><h2>4. Cài cloudflared & khởi chạy</h2><button id="install-cf">Cài / cập nhật cloudflared</button></div><p class="muted">Tải bản Windows x64 từ release chính thức, kiểm tra SHA256 trước khi lưu. Dừng tunnel trước khi cập nhật. Có thể dùng CLOUDFLARED_PATH trong Cấu hình để chọn binary đã cài.</p><div class="actions"><button class="primary" id="cf-start">Chạy MCP & tunnel</button><button data-go="gpt">Tiếp tục setup GPT →</button></div><div id="cf-current"></div></div>`;
  let zones = [], preview = cf.preview;
  const showError = error => { if (epoch !== viewEpoch) return; const node = $('#cf-error'); node.hidden = false; node.textContent = error.message; };
  const on = (selector, handler, event = 'click') => bind(selector, async (...args) => {
    if (epoch !== viewEpoch) return;
    $('#cf-error').hidden = true;
    try { await handler(...args); } catch (error) { if (error.code !== 'STALE_VIEW') showError(error); throw error; }
  }, event);
  const focusPreview = () => { $('#cf-preview').focus({ preventScroll: true }); $('#cf-preview').scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  let zoneRequest = 0;
  const selectZone = async (saved = null) => {
    const request = ++zoneRequest, zone = zones.find(z => z.id === $('#cf-zone').value);
    $('#cf-tunnel').innerHTML = '<option value="">Tạo tunnel mới</option>';
    $('#cf-tunnel').disabled = true;
    if (!zone) { $('#zone-info').textContent = ''; $('#cf-tunnel').disabled = false; return; }
    $('#cf-hostname').value = saved?.hostname || `mcp.${zone.name}`;
    $('#cf-name').value = saved?.name || 'chatgpt-local';
    $('#zone-info').textContent = zone.status === 'active' ? `Account: ${zone.account.name}` : `Domain chưa active. Đổi nameserver tại nơi mua domain: ${(zone.nameservers || []).join(', ')}`;
    try {
      const rows = (await api(`/api/cloudflare/tunnels?accountId=${encodeURIComponent(zone.account.id)}`)).tunnels;
      if (epoch !== viewEpoch || request !== zoneRequest) return;
      $('#cf-tunnel').innerHTML = '<option value="">Tạo tunnel mới</option>' + rows.map(t => `<option value="${e(t.id)}">${e(t.name)} · ${e(t.status)}</option>`).join('');
      if (saved?.tunnelId && rows.some(t => t.id === saved.tunnelId)) $('#cf-tunnel').value = saved.tunnelId;
    } finally { if (epoch === viewEpoch && request === zoneRequest) $('#cf-tunnel').disabled = false; }
  };
  const showZones = async rows => {
    zones = rows; const selected = $('#cf-zone').value;
    $('#cf-zone').innerHTML = '<option value="">Chọn domain…</option>' + rows.map(z => `<option value="${e(z.id)}">${e(z.name)} · ${e(z.status)} · ${e(z.account.name)}</option>`).join('');
    const saved = preview || cf.current;
    $('#cf-zone').value = rows.some(z => z.id === selected) ? selected : saved?.zoneId || '';
    await selectZone(saved?.zoneId === $('#cf-zone').value ? saved : null);
  };
  const showPreview = value => {
    if (!value || epoch !== viewEpoch) return;
    preview = value;
    $('#cf-preview').innerHTML = `<h2>3. Xem trước thay đổi</h2><p>Tunnel: <b>${e(value.tunnelId || 'Tạo mới: ' + value.name)}</b></p><p>DNS: <code>${e(value.hostname)} → ${e(value.tunnelId || '<tunnel-id>')}.cfargotunnel.com</code> · Proxied</p><p>Ingress: chỉ <code>/mcp/&lt;token&gt;</code> → localhost MCP; phần còn lại trả 404.</p><p class="muted">Các ingress của hostname khác được giữ lại. Admin không được public.</p>${value.complete ? '<p>Đã hoàn tất setup.</p>' : value.steps?.length ? '<p>Setup chưa hoàn tất. Bấm Tiếp tục / thử lại để dùng tiến độ đã lưu.</p>' : '<p>Xem trước đã sẵn sàng. Bấm Áp dụng thay đổi để tạo tunnel và DNS.</p>'}${value.steps?.length ? `<p>Tiến độ đã lưu: ${e(value.steps.join(' → '))}</p>` : ''}${value.lastError ? `<div id="cf-last-error" class="callout warning" role="alert"><b>Dừng ở bước: ${e(value.lastError.stage)}</b><p>${e(value.lastError.message)}</p><small>${e(new Date(value.lastError.time).toLocaleString('vi-VN'))}</small></div>` : ''}<p id="cf-progress" class="muted" role="status" aria-live="polite"></p><div class="actions"><button class="primary" id="cf-apply">${value.complete ? 'Áp dụng lại cấu hình' : value.steps?.length ? 'Tiếp tục / thử lại' : 'Áp dụng thay đổi'}</button></div>`;
    on('#cf-apply', async (_, node) => {
      node.textContent = 'Đang áp dụng…'; $('#cf-progress').textContent = 'Đang kiểm tra domain, tạo tunnel, cấu hình ingress và DNS. Chờ phản hồi Cloudflare…';
      try {
        const result = await operation('/api/cloudflare/apply', { planId: value.id });
        if (epoch !== viewEpoch) return;
        showPreview(result); $('#cf-current').textContent = `Đã cấu hình ${result.hostname}`; notice('Cloudflare đã setup. Cài cloudflared rồi chạy tất cả.');
      } catch (error) {
        if (epoch !== viewEpoch) return;
        try { showPreview((await api('/api/cloudflare')).preview); } catch { showPreview(preview); }
        focusPreview(); throw error;
      }
    });
  };
  on('#cf-token-form', async () => { const token = $('#cf-token').value; $('#cf-token').value = ''; const rows = (await api('/api/cloudflare/connect', 'POST', { token })).zones; if (epoch !== viewEpoch) return; await showZones(rows); $('#load-zones').disabled = false; notice('Token hợp lệ. Chọn domain để tiếp tục.'); }, 'submit');
  on('#load-zones', async () => showZones((await api('/api/cloudflare/zones')).zones));
  on('#cf-zone', () => selectZone(), 'change');
  on('#cf-selection', async () => {
    const zone = zones.find(z => z.id === $('#cf-zone').value); if (!zone) throw new Error('Chọn domain trước');
    if ($('#cf-tunnel').disabled) throw new Error('Đang tải danh sách tunnel. Chờ một lát rồi xem trước.');
    const node = $('#cf-selection button[type="submit"]'); node.textContent = 'Đang xem trước…';
    try { showPreview((await api('/api/cloudflare/preview', 'POST', { accountId: zone.account.id, zoneId: zone.id, hostname: $('#cf-hostname').value, tunnelId: $('#cf-tunnel').value || undefined, name: $('#cf-name').value })).preview); if (epoch === viewEpoch) focusPreview(); }
    finally { node.textContent = 'Xem trước thay đổi →'; }
  }, 'submit');
  bind('#install-cf', async () => { notice('Đang tải và kiểm tra SHA256…'); const result = await operation('/api/cloudflare/install', {}); notice(`Đã cài cloudflared ${result.version}`); });
  bind('#cf-start', () => lifecycle('all', 'start')); bind('[data-go]', (_, node) => render(node.dataset.go));
  if (preview) showPreview(preview);
  if (cf.current?.complete) $('#cf-current').textContent = `Đang dùng: ${cf.current.hostname} · Tunnel ${cf.current.tunnelId}`;
  const binary = await api('/api/cloudflare/binary');
  const info = document.createElement('p'); info.className = 'muted'; info.textContent = binary.installed ? `${binary.version} · ${binary.path}` : binary.error;
  $('#cf-current').append(info);
  if (cf.tokenConfigured) {
    try { await showZones((await api('/api/cloudflare/zones')).zones); }
    catch (error) { if (error.code !== 'STALE_VIEW') showError(error); }
  }
}
async function gpt(reveal = false) {
  const values = await api(`/api/gpt${reveal ? '?reveal=1' : ''}`);
  content().innerHTML = head('Kết nối với ChatGPT', 'Dùng Server URL của Cloudflare Tunnel đã binding vào domain.') +
    `<div class="card"><div class="card-head"><h2>Thông tin để thêm app</h2><button id="reveal-gpt">Xem URL đầy đủ</button></div><label for="gpt-url">Server URL ${values.activeUrl ? '(đang chạy)' : '(đã lưu, MCP chưa chạy)'}</label><div class="url-field"><input id="gpt-url" readonly value="${e(values.serverUrl || 'Hoàn tất setup Cloudflare trước')}"><button id="copy-gpt" ${values.serverUrl ? '' : 'disabled'}>Copy URL</button></div><div class="grid two"><div><h3>Connection</h3><p>Server URL</p></div><div><h3>Authentication</h3><p>No authentication</p></div></div><p class="muted">URL chứa MCP_TOKEN và được coi như mật khẩu. Xác nhận mật khẩu admin để xem/copy.</p>${values.savedUrl && values.activeUrl && values.savedUrl !== values.activeUrl ? '<div class="callout warning">Token đã lưu khác token đang chạy. Khởi động lại MCP rồi cập nhật app trên GPT.</div>' : ''}<div class="actions"><button class="primary" id="probe-gpt">Kiểm tra MCP qua domain</button><button data-go="overview">Quản lý khởi chạy</button></div><pre id="probe-result" hidden></pre></div>` +
    `<div class="grid two"><div class="card"><h2>Các bước trên GPT</h2><ol class="instruction-list"><li>Bật Developer mode trong phần Apps của tài khoản hỗ trợ MCP.</li><li>Tạo app/plugin MCP tùy chỉnh; chọn <b>Server URL</b>.</li><li>Dán URL đầy đủ phía trên, chọn <b>No authentication</b> rồi tạo kết nối.</li><li>Mở chat mới, chọn app và yêu cầu: <code>agent_status</code>, sau đó <code>project_context</code>.</li><li>Khi server, token hoặc tool thay đổi: Refresh app rồi mở chat mới.</li></ol><a href="https://developers.openai.com/api/docs/guides/custom-mcp-server" target="_blank" rel="noreferrer">Hướng dẫn MCP chính thức ↗</a></div><div class="card"><h2>URL quản lý & chẩn đoán</h2>${[['Admin local', values.adminUrl], ['Health local', values.localHealth], ['Cloudflare dashboard', values.cloudflareDashboard], ['DNS records', values.dnsDashboard]].map(([label, url]) => `<label>${e(label)}</label>${url ? `<a href="${e(url)}" target="_blank" rel="noreferrer">${e(url)}</a>` : '<span class="muted">Chưa cấu hình</span>'}`).join('')}<div class="callout warning">Nếu GPT báo rate limited: chờ theo thời gian retry, kiểm tra tunnel đang connected và chạy kiểm tra domain. Lỗi này không nhất thiết do MCP local.</div></div></div>`;
  bind('#reveal-gpt', async () => { await reauth(); revealedAt = Date.now(); await gpt(true); });
  bind('#copy-gpt', async () => { await reauth(); const fresh = await api('/api/gpt?reveal=1'); await navigator.clipboard.writeText(fresh.serverUrl); notice('Đã copy Server URL'); });
  bind('#probe-gpt', async () => { notice('Đang initialize và tools/list qua domain…'); const result = await operation('/api/gpt/probe', {}); $('#probe-result').hidden = false; $('#probe-result').textContent = JSON.stringify(result, null, 2); notice('MCP qua domain truy cập được'); });
  bind('[data-go]', (_, node) => render(node.dataset.go));
}
async function config(reveal = false) {
  const data = await api(`/api/config/env${reveal ? '?reveal=1' : ''}`); envOriginal = data.values;
  content().innerHTML = head('Cấu hình ứng dụng', 'Đối chiếu cấu hình đã lưu và đang chạy. Thay đổi có hiệu lực sau khi restart.', '<button id="reveal-config">Xem thông tin bảo mật</button>') +
    `<div class="card"><form id="env-form"><div class="table-wrap"><table><thead><tr><th>CONFIG</th><th>ĐÃ LƯU</th><th>ĐANG CHẠY</th></tr></thead><tbody>${Object.keys(data.values).sort().map(key => `<tr><td class="config-key"><code>${e(key)}</code></td><td><input aria-label="${e(key)}" data-env="${e(key)}" value="${e(data.values[key])}" ${data.values[key] === '[hidden]' ? 'readonly' : ''}></td><td><code>${e(data.active?.[key] ?? '—')}</code></td></tr>`).join('')}</tbody></table></div><div class="field-row"><div><label for="new-key">Thêm config (tên)</label><input id="new-key" placeholder="EXAMPLE_SETTING" pattern="[A-Z][A-Z0-9_]*"></div><div><label for="new-value">Giá trị</label><input id="new-value" autocomplete="off"></div></div><div class="actions"><button class="primary" type="submit">Lưu thay đổi</button><button type="button" id="config-restart">Restart MCP & tunnel</button></div></form><div class="callout">Admin luôn bind 127.0.0.1. Đổi ADMIN_PORT cần thoát ứng dụng và mở lại launcher. PORT là cổng gateway chung; cổng runtime nằm ở Workspaces. Đổi PORT cần thoát ứng dụng, mở lại launcher và áp dụng lại ingress. WORKSPACE_PATH là thư mục mặc định của công cụ; quyền file vẫn là full machine access.</div></div>` +
    `<div class="card"><h2>Vault Cloudflare</h2><p class="muted">Mã hóa DPAPI CurrentUser · Không lưu API token hoặc tunnel token trong .env.</p><pre>${e(JSON.stringify(data.vault, null, 2))}</pre></div><div class="card"><h2>Đổi mật khẩu admin</h2><form id="password-form"><div class="field-row"><div><label for="current-password">Mật khẩu hiện tại</label><input id="current-password" type="password" required autocomplete="current-password"></div><div><label for="new-password">Mật khẩu mới (12–256 ký tự)</label><input id="new-password" type="password" minlength="12" maxlength="256" required autocomplete="new-password"></div></div><div class="actions"><button type="submit">Đổi mật khẩu & đăng xuất các phiên</button></div></form></div>`;
  bind('#reveal-config', async () => { await reauth(); revealedAt = Date.now(); await config(true); });
  bind('#env-form', async () => {
    const values = {}; document.querySelectorAll('[data-env]').forEach(node => { if (node.value !== envOriginal[node.dataset.env]) values[node.dataset.env] = node.value; });
    if ($('#new-key').value) values[$('#new-key').value] = $('#new-value').value;
    if (!Object.keys(values).length) { notice('Chưa có thay đổi'); return; }
    if (Object.keys(values).some(key => /TOKEN|KEY|SECRET|PASSWORD/.test(key))) await reauth();
    await api('/api/config/env', 'PUT', { values }); notice('Đã lưu. Restart để áp dụng.'); await config();
  }, 'submit');
  bind('#config-restart', () => lifecycle('all', 'restart'));
  bind('#password-form', async () => { await api('/api/auth/password', 'POST', { currentPassword: $('#current-password').value, password: $('#new-password').value }); window.dispatchEvent(new Event('signed-out')); }, 'submit');
}
let upstreamTab = 'servers';
async function upstream() {
  content().innerHTML = head('MCP & công cụ', 'Quản lý upstream, import từ các ứng dụng và tùy chỉnh công cụ local.') + `<div class="tab-bar">${[['servers','MCP upstream'],['import','Import'],['plugins','Plugins'],['hooks','Hooks'],['tools','Công cụ local']].map(([key, label]) => `<button data-up-tab="${key}" class="${key === upstreamTab ? 'active' : ''}">${label}</button>`).join('')}</div><div id="up-body"></div>`;
  bind('[data-up-tab]', (_, node) => { upstreamTab = node.dataset.upTab; return render('upstream'); });
  const body = $('#up-body');
  if (upstreamTab === 'servers') {
    const data = await api('/api/upstream');
    body.innerHTML = `<div class="card"><div class="card-head"><h2>MCP upstream</h2><button id="edit-upstream">Sửa toàn bộ config</button></div><div class="table-wrap"><table><thead><tr><th>SERVER</th><th>TRANSPORT</th><th>TRẠNG THÁI</th><th>THAO TÁC</th></tr></thead><tbody>${data.config.servers.map(server => `<tr><td><b>${e(server.name || server.id)}</b><br><small>${e(server.id)}</small></td><td>${e(server.transport)}</td><td>${badge(server.enabled ? 'enabled' : 'disabled')}</td><td><div class="actions"><button data-test="${e(server.id)}">Test</button><button data-tools="${e(server.id)}">Tools</button><button data-oauth="${e(server.id)}">OAuth</button></div></td></tr>`).join('')}</tbody></table></div>${data.config.servers.length ? '' : empty('Chưa có upstream. Import hoặc thêm vào config.')}<pre id="up-result" hidden></pre><div id="up-editor" hidden><label for="up-json">Config JSON</label><textarea id="up-json" class="editor"></textarea><div class="actions"><button class="primary" id="save-upstream">Lưu config</button></div></div></div>`;
    bind('#edit-upstream', async () => { await reauth(); revealedAt = Date.now(); const fresh = await api('/api/upstream?reveal=1'); $('#up-editor').hidden = false; $('#up-json').value = JSON.stringify(fresh.config, null, 2); });
    bind('#save-upstream', async () => { await api('/api/upstream', 'PUT', { config: JSON.parse($('#up-json').value) }); notice('Đã lưu upstream. Mở phiên MCP mới để cập nhật tool.'); await upstream(); });
    const result = value => { $('#up-result').hidden = false; $('#up-result').textContent = JSON.stringify(value, null, 2); };
    bind('[data-test]', async (_, node) => result(await api(`/api/upstream/${encodeURIComponent(node.dataset.test)}/test`, 'POST', {})));
    bind('[data-tools]', async (_, node) => result(await api(`/api/upstream/${encodeURIComponent(node.dataset.tools)}/tools`)));
    bind('[data-oauth]', async (_, node) => {
      const value = await api(`/api/upstream/${encodeURIComponent(node.dataset.oauth)}/oauth/start`, 'POST', {}); result(value);
      const url = value.status?.authorization_url || value.status?.auth_url;
      if (url) { const parsed = new URL(url); if (['https:', 'http:'].includes(parsed.protocol)) { const link = document.createElement('a'); link.href = url; link.target = '_blank'; link.rel = 'noreferrer'; link.textContent = 'Tiếp tục xác thực OAuth ↗'; $('#up-result').after(link); } }
    });
  } else if (upstreamTab === 'import') {
    const data = await api('/api/import/sources');
    body.innerHTML = `<div class="card"><h2>Import cấu hình MCP</h2><pre>${e(JSON.stringify(data.sources, null, 2))}</pre><form id="import-form"><label for="import-source">Nguồn</label><select id="import-source"><option value="cursor">Cursor</option><option value="claude">Claude Code / Desktop</option><option value="opencode">OpenCode</option><option value="file">File JSON</option></select><label for="import-path">Đường dẫn (để trống để tự dò)</label><input id="import-path" placeholder="D:\\path\\mcp.json"><label class="check"><input id="import-enable" type="checkbox"> Bật server sau khi import</label><button class="primary" type="submit">Import & merge</button></form><pre id="import-result" hidden></pre></div>`;
    bind('#import-form', async () => { const result = await api(`/api/import/${$('#import-source').value}`, 'POST', { path: $('#import-path').value || undefined, merge: true, enable: $('#import-enable').checked }); $('#import-result').hidden = false; $('#import-result').textContent = JSON.stringify(result, null, 2); notice('Đã import MCP'); }, 'submit');
  } else if (upstreamTab === 'plugins') {
    const data = await api('/api/plugins');
    body.innerHTML = `<div class="card"><h2>Plugins local</h2><label class="check"><input id="computer-use" type="checkbox" ${data.config.computer_use?.enabled ? 'checked' : ''}> Computer use (Windows)</label><p class="muted">Mở phiên MCP mới sau khi thay đổi trạng thái plugin.</p><button id="save-plugins" class="primary">Lưu</button></div>`;
    bind('#save-plugins', async () => { await api('/api/plugins', 'PUT', { config: { computer_use: { enabled: $('#computer-use').checked } } }); notice('Đã lưu plugin'); });
  } else if (upstreamTab === 'hooks') {
    const data = await api('/api/codex-hooks');
    body.innerHTML = `<div class="card"><h2>Codex hooks</h2><p class="muted">Chọn các hook được phép chạy khi bắt đầu phiên MCP.</p>${data.hooks.map(hook => `<label class="check"><input type="checkbox" data-hook="${e(hook.id)}" ${hook.enabled ? 'checked' : ''}> ${e(hook.name || hook.id)}</label><small>${e(hook.command)}</small>`).join('') || empty('Không tìm thấy hook.')}<div class="actions"><button id="save-hooks" class="primary">Lưu enabled</button></div></div>`;
    bind('#save-hooks', async () => { const enabled = [...document.querySelectorAll('[data-hook]:checked')].map(node => node.dataset.hook); await api('/api/codex-hooks', 'PUT', { enabled }); notice('Đã lưu hooks'); });
  } else {
    const data = await api('/api/local-tools');
    body.innerHTML = `<div class="card"><h2>Công cụ local</h2><p class="muted">Mặc định theo CHATGPT_TOOL_PROFILE; override được áp dụng cho phiên mới.</p><div class="table-wrap"><table><thead><tr><th>TOOL</th><th>HIỂN THỊ</th></tr></thead><tbody>${data.tools.map(tool => `<tr><td><code>${e(tool)}</code></td><td><select data-tool="${e(tool)}"><option value="default">Theo profile</option><option value="enabled" ${(data.overrides.enabled || []).includes(tool) ? 'selected' : ''}>Bật</option><option value="disabled" ${(data.overrides.disabled || []).includes(tool) ? 'selected' : ''}>Tắt</option></select></td></tr>`).join('')}</tbody></table></div><div class="actions"><button id="save-tools" class="primary">Lưu override</button></div></div>`;
    bind('#save-tools', async () => { const overrides = { enabled: [], disabled: [] }; document.querySelectorAll('[data-tool]').forEach(node => { if (node.value !== 'default') overrides[node.value].push(node.dataset.tool); }); await api('/api/local-tools', 'PUT', { overrides }); notice('Đã lưu. Mở phiên MCP mới.'); });
  }
}
let logEntries = [];
export function addLog(entry) { logEntries.push(entry); if (logEntries.length > 1000) logEntries.shift(); if (page === 'logs') paintLogs(); }
function paintLogs() {
  const node = $('#log-entries'); if (!node) return;
  const query = ($('#log-filter')?.value || '').toLowerCase(); const source = $('#log-source')?.value || '';
  const rows = logEntries.filter(row => (!source || row.source === source) && JSON.stringify(row).toLowerCase().includes(query)).slice(-200).reverse();
  node.innerHTML = rows.length ? rows.map(row => `<div class="log"><time>${e(new Date(row.time).toLocaleTimeString('vi-VN'))}</time><span class="badge">${e(row.source)}</span>${e(row.message)}</div>`).join('') : empty('Chưa có log phù hợp.');
}
async function logs() {
  logEntries = (await api('/api/logs')).entries;
  content().innerHTML = head('Nhật ký hoạt động', 'Theo dõi controller, MCP, tunnel và hoạt động công cụ.', '<a href="/api/logs/export" download>Xuất log JSON ↓</a>') + `<div class="card"><div class="field-row"><input id="log-filter" aria-label="Tìm trong log" placeholder="Tìm nội dung, lỗi hoặc tool…"><select id="log-source" aria-label="Nguồn log"><option value="">Tất cả nguồn</option><option value="controller">Controller</option><option value="mcp">MCP</option><option value="tunnel">Tunnel</option><option value="activity">Hoạt động tool</option></select></div><p class="muted">Hiển thị 200 dòng gần nhất phù hợp bộ lọc. Token đã biết được che khi xuất.</p><div id="log-entries"></div></div>`;
  bind('#log-filter', paintLogs, 'input'); bind('#log-source', paintLogs, 'change'); paintLogs();
}
setInterval(() => { if (revealedAt && Date.now() - revealedAt > 300000) { forgetSecrets(); void render(page); } }, 10000);
