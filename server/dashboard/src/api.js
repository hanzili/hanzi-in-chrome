const BASE = '';

export async function api(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(BASE + path, opts);
  if (res.status === 401) {
    await redirectToSignIn();
    return null;
  }
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

async function redirectToSignIn() {
  try {
    // Better Auth social sign-in: POST to get the OAuth redirect URL
    const res = await fetch('/api/auth/sign-in/social', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        provider: 'google',
        callbackURL: '/dashboard',
      }),
    });
    const data = await res.json().catch(() => null);
    if (data?.url) {
      window.location.href = data.url;
      return;
    }
  } catch {}
  // Fallback: try the direct URL in case Better Auth version differs
  window.location.href = '/api/auth/sign-in/social?provider=google&callbackURL=/dashboard';
}
