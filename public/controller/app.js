import { api, setCsrf } from './api.js';
import { $, notice } from './ui.js';
import { render, currentPage, titles, refreshStatus, addLog, forgetSecrets } from './pages.js';
const nonce = new URLSearchParams(location.hash.slice(1)).get('bootstrap');
if (nonce) history.replaceState(null, '', location.pathname);
let setup = false, events, authenticated = false, reauthResolve;
const theme = localStorage.getItem('local-mcp-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
document.documentElement.dataset.theme = theme;
$('#theme').addEventListener('click', () => { const value = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = value; localStorage.setItem('local-mcp-theme', value); });
function signedOut() {
  authenticated = false; setup = false; events?.close(); forgetSecrets(); setCsrf(''); $('#content').innerHTML = ''; $('#shell').hidden = true; $('#auth-screen').hidden = false;
  $('#auth-password').value = ''; $('#auth-password').minLength = 0; $('#auth-password').autocomplete = 'current-password';
  $('#auth-confirm').value = ''; $('#auth-confirm').required = false; $('#auth-confirm').hidden = $('#confirm-label').hidden = true;
  $('#auth-title').textContent = 'Chào mừng trở lại'; $('#auth-description').textContent = 'Đăng nhập để quản lý server và Cloudflare Tunnel.'; $('#auth-submit').textContent = 'Đăng nhập'; $('#auth-error').textContent = '';
  $('#reauth-dialog').close(); reauthResolve?.(false);
}
window.addEventListener('signed-out', signedOut);
function reauthenticate() {
  return new Promise((resolve, reject) => { $('#reauth-password').value = ''; $('#reauth-error').textContent = ''; $('#reauth-dialog').showModal(); $('#reauth-password').focus(); reauthResolve = success => { reauthResolve = null; success ? resolve() : reject(new Error('Đã hủy xác nhận mật khẩu')); }; });
}
$('#reauth-cancel').addEventListener('click', () => { $('#reauth-dialog').close(); reauthResolve?.(false); });
$('#reauth-dialog').addEventListener('cancel', () => reauthResolve?.(false));
$('#reauth-form').addEventListener('submit', async event => { event.preventDefault(); const button = event.submitter || $('#reauth-form button[type="submit"]'); button.disabled = true; try { await api('/api/auth/reauth', 'POST', { password: $('#reauth-password').value }); $('#reauth-password').value = ''; $('#reauth-dialog').close(); reauthResolve?.(true); } catch (error) { $('#reauth-error').textContent = error.message; } finally { button.disabled = false; } });
async function signedIn() {
  authenticated = true; $('#auth-screen').hidden = true; $('#shell').hidden = false; $('#auth-password').value = ''; $('#auth-confirm').value = '';
  await render(titles[location.hash.slice(1)] ? location.hash.slice(1) : 'overview', reauthenticate);
  events?.close(); events = new EventSource('/api/events');
  events.addEventListener('status', event => refreshStatus(JSON.parse(event.data)));
  events.addEventListener('log', event => addLog(JSON.parse(event.data)));
  events.onerror = async () => { if (!authenticated) return; try { const session = await api('/api/auth/session'); if (!session.authenticated) signedOut(); } catch { notice('Mất kết nối controller. Kiểm tra launcher.', true); } };
}
$('#auth-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = $('#auth-submit'); button.disabled = true; $('#auth-error').textContent = '';
  try {
    const password = $('#auth-password').value;
    if (setup && password !== $('#auth-confirm').value) throw new Error('Hai mật khẩu không khớp');
    const result = await api(`/api/auth/${setup ? 'setup' : 'login'}`, 'POST', { password, ...(setup ? { nonce } : {}) });
    setCsrf(result.csrf); setup = false; await signedIn();
  } catch (error) { $('#auth-error').textContent = error.message; } finally { button.disabled = false; }
});
$('#logout').addEventListener('click', async () => { try { await api('/api/auth/logout', 'POST', {}); signedOut(); } catch (error) { notice(error.message, true); } });
document.querySelectorAll('[data-page]').forEach(node => node.addEventListener('click', () => { history.replaceState(null, '', `#${node.dataset.page}`); forgetSecrets(); void render(node.dataset.page); }));
document.addEventListener('visibilitychange', () => { if (document.hidden && authenticated) { forgetSecrets(); void render(currentPage()); } });
try {
  const session = await api('/api/auth/session'); setup = session.setupRequired;
  $('#auth-title').textContent = setup ? 'Tạo mật khẩu quản trị' : 'Chào mừng trở lại';
  $('#auth-description').textContent = setup ? 'Đặt mật khẩu từ 12 đến 256 ký tự để bảo vệ panel.' : 'Đăng nhập để quản lý server và Cloudflare Tunnel.';
  $('#auth-submit').textContent = setup ? 'Tạo mật khẩu & tiếp tục' : 'Đăng nhập';
  $('#confirm-label').hidden = $('#auth-confirm').hidden = !setup; $('#auth-confirm').required = setup;
  $('#auth-password').minLength = setup ? 12 : 0; $('#auth-password').autocomplete = setup ? 'new-password' : 'current-password';
  if (setup && !nonce) $('#auth-error').textContent = 'Mở lại launcher để nhận link tạo mật khẩu lần đầu.';
  if (session.authenticated) { setCsrf(session.csrf); await signedIn(); }
} catch (error) { $('#auth-error').textContent = error.message; }
