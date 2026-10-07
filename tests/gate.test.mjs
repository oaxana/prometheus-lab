import { ROOT } from './lib.mjs';
import fs from 'node:fs';
const mw = (await import(ROOT + '/middleware.js')).default;
let pass = 0, total = 0;
const check = (n, ok, x = '') => { total++; if (ok) pass++; console.log(ok ? 'PASS' : 'FAIL', n, x); };
const B = 'https://prometheus-lab-xi.vercel.app';
const req = (path, o = {}) => new Request(B + path, o);
const login = (pw) => req('/__login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=' + encodeURIComponent(pw) });
const isNext = (r) => r.headers.get('x-middleware-next') === '1';

// 1. fail closed when env var missing
delete process.env.SITE_PASSWORD;
let r = await mw(req('/'));
check('no SITE_PASSWORD -> 503 locked', r.status === 503 && (await r.text()).includes('SITE_PASSWORD'));
r = await mw(req('/api/summarize', { method: 'POST' }));
check('no SITE_PASSWORD -> API also locked', r.status === 503);

process.env.SITE_PASSWORD = 'correct horse battery staple';

// 2. everything locked without a cookie
r = await mw(req('/')); const page = await r.text();
check('/ -> login page 401', r.status === 401 && page.includes('type="password"') && page.includes('Prometheus Lab'));
check('login page not cacheable / noindex', r.headers.get('cache-control') === 'no-store' && r.headers.get('x-robots-tag') === 'noindex');
for (const p of ['/config.js', '/app.js', '/styles.css', '/index.html', '/anything']) {
  r = await mw(req(p)); check(`${p} locked`, r.status === 401 && !isNext(r));
}
r = await mw(req('/api/summarize', { method: 'POST', body: '{}' }));
check('/api/summarize locked w/ JSON code', r.status === 401 && (await r.json()).code === 'crew_login');
r = await mw(req('/api/synthesize', { method: 'POST' })); check('/api/synthesize locked', r.status === 401);
r = await mw(req('/api/test-persona-submit', { method: 'POST' })); check('/api/test-persona-submit locked', r.status === 401);

// 3. wrong passwords
let t = Date.now(); r = await mw(login('wrong'));
check('wrong password -> 401 + error + delayed', r.status === 401 && (await r.text()).includes("isn't right") && Date.now() - t >= 900, `${Date.now() - t}ms`);
r = await mw(login('')); check('empty password rejected', r.status === 401 && !r.headers.get('set-cookie'));
r = await mw(login('correct horse battery stapl')); check('prefix of password rejected', r.status === 401);
r = await mw(login('correct horse battery staple ')); check('trailing-space variant rejected', r.status === 401);
r = await mw(req('/__login', { method: 'POST', body: 'garbage', headers: { 'content-type': 'text/plain' } }));
check('malformed login body does not crash', r.status === 401);

// 4. right password
r = await mw(login('correct horse battery staple'));
const sc = r.headers.get('set-cookie') || '';
check('right password -> 303 to /', r.status === 303 && r.headers.get('location') === '/');
check('cookie flags HttpOnly/Secure/SameSite/30d', /HttpOnly/.test(sc) && /Secure/.test(sc) && /SameSite=Lax/.test(sc) && /Max-Age=2592000/.test(sc), sc.replace(/=[0-9a-f]{64}/, '=<hash>'));
check('cookie does not contain the password', !sc.includes('correct') && !sc.includes('horse'));
const cookie = sc.split(';')[0];

// 5. with cookie -> passes through
for (const p of ['/', '/config.js', '/app.js']) { r = await mw(req(p, { headers: { cookie } })); check(`${p} allowed with cookie`, isNext(r)); }
r = await mw(req('/api/summarize', { method: 'POST', headers: { cookie: 'other=1; ' + cookie } })); check('API allowed with cookie among others', isNext(r));

// 6. tampering / rotation
r = await mw(req('/', { headers: { cookie: cookie.slice(0, -1) + (cookie.endsWith('a') ? 'b' : 'a') } })); check('tampered cookie rejected', r.status === 401);
r = await mw(req('/', { headers: { cookie: 'pl_session=' } })); check('empty cookie rejected', r.status === 401);
r = await mw(req('/', { headers: { cookie: 'pl_session=correct horse battery staple' } })); check('raw password as cookie rejected', r.status === 401);
process.env.SITE_PASSWORD = 'new password';
r = await mw(req('/', { headers: { cookie } })); check('old cookie dies when password rotated', r.status === 401);

// 7. http (local dev) omits Secure so cookie works on http://localhost
r = await mw(new Request('http://localhost:3000/__login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=new%20password' }));
check('http localhost: no Secure flag', !/Secure/.test(r.headers.get('set-cookie') || ''));

fs.writeFileSync(new URL('./screens/gate-login.html', import.meta.url), page);
console.log(`\n${pass}/${total} passed`);
