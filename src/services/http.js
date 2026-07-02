// Global fetch patch: attaches the app auth token to every same-origin /api
// request and broadcasts an event when the server rejects the session, so App
// can force a re-login. Patched once at startup (imported from main.jsx) —
// this way the dozens of existing fetch() call sites across services and apps
// don't each need an auth-aware wrapper.

const TOKEN_KEY = 'dnl_auth_token';

function getAuthToken() {
  try {
    const session = JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null');
    return session?.token || '';
  } catch {
    return '';
  }
}

function isApiUrl(url) {
  return url.startsWith('/api/') || url.startsWith(`${window.location.origin}/api/`);
}

const origFetch = window.fetch.bind(window);

window.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : (input?.url || '');
  if (!isApiUrl(url)) return origFetch(input, init);

  const token = getAuthToken();
  const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
  if (token && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`);

  const res = await origFetch(input, { ...init, headers });

  // X-Auth-Required marks OUR auth middleware's 401 — as opposed to domain
  // 401s like Fathom's reconnect flow, which must NOT log the user out.
  if (res.status === 401 && res.headers.get('x-auth-required')) {
    window.dispatchEvent(new Event('dnl:unauthorized'));
  }
  return res;
};
