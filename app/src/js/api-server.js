const base = import.meta.env.BASE_URL;

async function call(path, body) {
  let r;
  try {
    r = await fetch(base + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  } catch { throw Object.assign(new Error('network'), { code: 'network' }); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error || 'http'), { ...d, code: d.error || 'http', status: r.status });
  return d;
}

export const lookup = (name) => call('api/lookup', { name });
export const register = (name, dni, email) => call('api/register', { name, dni, email });
export const ticket = (token) => call('api/ticket/' + encodeURIComponent(token)).catch((e) => { if (e.code === 'not_found') return null; throw e; });
export const login = (pin, screenId) => call('api/login', { pin, screenId });
export const startAttempt = (session) => call('api/attempts', { session });
export const finishAttempt = (id, score, durationMs) => call(`api/attempts/${encodeURIComponent(id)}/result`, { score, durationMs });
