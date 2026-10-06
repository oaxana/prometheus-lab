// Crew password gate. Runs on Vercel in front of EVERY request — the pages, config.js and /api/* —
// so nothing (including the Supabase key and the AI endpoints) is reachable without the password.
//
// Set SITE_PASSWORD in Vercel → Settings → Environment Variables. If it is missing, the site stays locked.
import { next } from '@vercel/functions';
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

const COOKIE = 'pl_session';
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

// The cookie holds a keyed hash, never the password. Changing SITE_PASSWORD invalidates every cookie.
const sessionToken = (password) => createHmac('sha256', password).update('prometheus-lab-session-v1').digest('hex');

// Constant-time comparison (hashing first makes the two buffers the same length).
const safeEqual = (a, b) =>
  timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

function getCookie(request, name) {
  const hit = (request.headers.get('cookie') || '').split(/;\s*/).find((c) => c.startsWith(name + '='));
  return hit ? hit.slice(name.length + 1) : '';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE_HEAD = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' };

function loginPage({ error = false, notConfigured = false } = {}) {
  const body = notConfigured
    ? `<p class="msg">This site isn't set up yet.<br>The <strong>SITE_PASSWORD</strong> environment variable is missing.</p>`
    : `<form method="POST" action="/__login">
         <input type="password" name="password" placeholder="Crew password" autocomplete="current-password" autofocus required>
         <button type="submit">Enter</button>
         ${error ? '<p class="err">That password isn\'t right.</p>' : ''}
       </form>`;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>Prometheus Lab</title>
<style>
:root{--bg:#0d0b14;--surface:#181522;--border:#2d2a40;--text:#e0dbd0;--muted:#a09aad;--accent:#e8923a;--bad:#f0a245;
  --font:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
@media(prefers-color-scheme:light){:root{--bg:#f8f5ef;--surface:#fff;--border:#ddd6ca;--text:#1a1510;--muted:#887d70;--accent:#c07020;--bad:#d07828}}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--font);background:var(--bg);color:var(--text);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px;-webkit-font-smoothing:antialiased}
.box{width:100%;max-width:360px;text-align:center}
.flame{font-size:48px;display:block;margin-bottom:12px}
h1{font-size:24px;font-weight:700;margin-bottom:8px}
.sub{color:var(--muted);font-size:15px;margin-bottom:24px}
form{display:flex;flex-direction:column;gap:12px}
input{width:100%;padding:12px 14px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text);font-family:var(--font);font-size:15px;outline:0;text-align:center}
input:focus{border-color:var(--accent)}input::placeholder{color:var(--muted)}
button{font-family:var(--font);font-size:15px;font-weight:600;padding:12px 28px;border:0;border-radius:8px;background:var(--accent);color:#fff;cursor:pointer}
button:hover{filter:brightness(1.1)}
.err{color:var(--bad);font-size:13px}.msg{color:var(--muted);font-size:14px;line-height:1.6}
</style></head><body><div class="box">
<span class="flame">🔥</span><h1>Prometheus Lab</h1><p class="sub">Crew only</p>
${body}
</div></body></html>`;
}

const html = (status, body) => new Response(body, { status, headers: PAGE_HEAD });

export default async function middleware(request) {
  const password = process.env.SITE_PASSWORD;
  if (!password) return html(503, loginPage({ notConfigured: true })); // fail closed

  const url = new URL(request.url);
  const authed = safeEqual(getCookie(request, COOKIE), sessionToken(password));

  // Login form submission
  if (url.pathname === '/__login' && request.method === 'POST') {
    if (authed) return new Response(null, { status: 303, headers: { Location: '/' } });
    let given = '';
    try {
      given = String((await request.formData()).get('password') ?? '');
    } catch {}
    if (given && safeEqual(given, password)) {
      const flags = `Path=/; Max-Age=${MAX_AGE}; HttpOnly; SameSite=Lax${url.protocol === 'https:' ? '; Secure' : ''}`;
      return new Response(null, {
        status: 303,
        headers: { Location: '/', 'Set-Cookie': `${COOKIE}=${sessionToken(password)}; ${flags}`, 'Cache-Control': 'no-store' },
      });
    }
    await sleep(1000); // slows down guessing
    return html(401, loginPage({ error: true }));
  }

  if (authed) return next();

  // Not logged in: the API gets JSON, everything else gets the login page.
  if (url.pathname.startsWith('/api/')) {
    return new Response(JSON.stringify({ error: 'Crew password required.', code: 'crew_login' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }
  return html(401, loginPage());
}
