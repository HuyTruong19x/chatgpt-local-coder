export const $ = (selector, root = document) => root.querySelector(selector);
export const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
let timer;
export function notice(message, error = false) { const node = $('#notice'); node.textContent = message; node.className = `notice${error ? ' error' : ''}`; node.hidden = false; clearTimeout(timer); timer = setTimeout(() => { node.hidden = true; }, error ? 12000 : 5000); }
export function bind(selector, handler, event = 'click') {
  document.querySelectorAll(selector).forEach(node => {
    let busy = false;
    node.addEventListener(event, async e => {
      if (event === 'submit') e.preventDefault();
      if (busy) return;
      busy = true;
      const buttons = event === 'submit' ? [...node.querySelectorAll('button[type="submit"]')] : [node];
      const disabled = buttons.map(button => button.disabled);
      buttons.forEach(button => { button.disabled = true; });
      try { await handler(e, node); }
      catch (error) { if (error.code !== 'STALE_VIEW') notice(error.message, true); }
      finally { busy = false; buttons.forEach((button, index) => { button.disabled = disabled[index]; }); }
    });
  });
}
export function badge(state) { return `<span class="badge ${['running','connected','active','complete'].includes(state) ? 'good' : ['error','degraded','unreachable'].includes(state) ? 'bad' : ''}">${escape(state)}</span>`; }
export function head(title, description, action = '') { return `<div class="page-head"><div><p class="eyebrow">LOCAL MCP / CONTROL CENTER</p><h1>${title}</h1><p>${description}</p></div>${action}</div>`; }
export function empty(message) { return `<div class="empty">${escape(message)}</div>`; }
