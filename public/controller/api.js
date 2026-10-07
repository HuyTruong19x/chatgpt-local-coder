export let csrf = '';
export function setCsrf(value) { csrf = value || ''; }
export async function api(url, method = 'GET', body) {
  const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) { const error = Object.assign(new Error(value.error || `HTTP ${response.status}`), { code: value.code, status: response.status }); if (response.status === 401 && value.code === 'AUTH_REQUIRED') window.dispatchEvent(new Event('signed-out')); throw error; }
  return value;
}
export async function operation(url, body, onUpdate) {
  const { operationId } = await api(url, 'POST', body);
  for (;;) {
    const result = await api(`/api/operations/${operationId}`);
    onUpdate?.(result);
    if (result.state === 'complete') return result.result;
    if (result.state === 'error') throw Object.assign(new Error(result.error), { code: result.code, retryAfter: result.retryAfter });
    await new Promise(resolve => setTimeout(resolve, 800));
  }
}
