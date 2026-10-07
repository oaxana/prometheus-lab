// Admin login endpoint (api/admin.js) and the admin check that guards synthesis, called directly (no browser).
import { ROOT } from './lib.mjs';
const admin = (await import(ROOT + '/api/admin.js')).default;
const synthesize = (await import(ROOT + '/api/synthesize.js')).default;
let pass = 0, total = 0;
const check = (n, ok, x = '') => { total++; if (ok) pass++; console.log(ok ? 'PASS' : 'FAIL', n, x); };

// Minimal stand-ins for Vercel's Node request/response.
const call = async (handler, { method = 'POST', body, cookie = '', https = false } = {}) => {
  const headers = {};
  const res = {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { headers[k.toLowerCase()] = v; return this; },
    json(b) { this.body = b; return this; },
  };
  await handler({ method, body, headers: { cookie, ...(https ? { 'x-forwarded-proto': 'https' } : {}) } }, res);
  return { status: res.statusCode, body: res.body, headers };
};
const login = (password, o = {}) => call(admin, { body: { action: 'login', password }, ...o });
const cookieOf = (r) => (r.headers['set-cookie'] || '').split(';')[0];

delete process.env.ADMIN_PASSWORD;
let r = await login('anything');
check('no ADMIN_PASSWORD -> login disabled (503), no cookie', r.status === 503 && !r.headers['set-cookie']);
r = await call(admin, { method: 'GET' });
check('no ADMIN_PASSWORD -> GET says not admin', r.status === 200 && r.body.admin === false);
r = await call(synthesize, { body: {} });
check('no ADMIN_PASSWORD -> synthesis disabled (503)', r.status === 503);

process.env.ADMIN_PASSWORD = 'correct horse admin';
let t = Date.now(); r = await login('wrong');
check('wrong password -> 401, no cookie, delayed', r.status === 401 && !r.headers['set-cookie'] && Date.now() - t >= 900, `${Date.now() - t}ms`);
for (const bad of ['', 'correct horse admi', 'correct horse admin ', 'CORRECT HORSE ADMIN']) {
  r = await login(bad); check(`near-miss password ${JSON.stringify(bad)} rejected`, r.status === 401);
}
r = await call(admin, { body: { password: 'correct horse admin' } });
check('missing action -> 400', r.status === 400);
r = await call(admin, { method: 'PUT' });
check('other methods -> 405', r.status === 405);

r = await login('correct horse admin', { https: true });
const set = r.headers['set-cookie'];
check('right password -> 200 + cookie', r.status === 200 && r.body.admin === true && set.startsWith('pl_admin='));
check('cookie is HttpOnly, SameSite=Strict, Secure on https, Path=/', /HttpOnly/.test(set) && /SameSite=Strict/.test(set) && /Secure/.test(set) && /Path=\//.test(set));
check('cookie is session-only (no Max-Age / Expires)', !/Max-Age|Expires/i.test(set));
check('cookie never contains the password', !set.includes('correct') && !set.includes('horse'));
check('responses are not cacheable', r.headers['cache-control'] === 'no-store');
const good = cookieOf(r);

r = await call(admin, { method: 'GET', cookie: good });
check('GET with the cookie -> admin', r.body.admin === true);
r = await call(admin, { method: 'GET', cookie: 'pl_admin=forged' });
check('GET with a forged cookie -> not admin', r.body.admin === false);
r = await call(admin, { method: 'GET', cookie: 'other=1; ' + good });
check('cookie found among other cookies', r.body.admin === true);

r = await call(synthesize, { body: {} });
check('synthesis without the cookie -> 401', r.status === 401);
r = await call(synthesize, { body: {}, cookie: 'pl_admin=forged' });
check('synthesis with a forged cookie -> 401', r.status === 401);
delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_ROLE_KEY;
r = await call(synthesize, { body: {}, cookie: good });
check('synthesis with the cookie passes the admin check (then needs Supabase)', r.status === 500 && r.body.error.includes('SUPABASE_URL'));

process.env.ADMIN_PASSWORD = 'a new password';
r = await call(admin, { method: 'GET', cookie: good });
check('changing ADMIN_PASSWORD logs every admin out', r.body.admin === false);

r = await call(admin, { body: { action: 'logout' } });
check('logout clears the cookie', r.status === 200 && r.body.admin === false && /pl_admin=;/.test(r.headers['set-cookie']) && /Max-Age=0/.test(r.headers['set-cookie']));

console.log(`\n${pass}/${total} passed`);
