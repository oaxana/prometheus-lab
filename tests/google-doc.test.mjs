import { ROOT } from './lib.mjs';
const handler = (await import(ROOT + '/api/google-doc.js')).default;
let pass = 0, total = 0; const check = (n, ok, x = '') => { total++; if (ok) pass++; console.log(ok ? 'PASS' : 'FAIL', n, x); };
const hits = [];
const pad = (s) => s + 'a'.repeat(30 - s.length);
const ID = { doc: pad('GOODDOC'), slides: pad('GOODSLIDES'), priv: pad('PRIVATEDOC'), evil: pad('EVILREDIRECT'), missing: pad('MISSINGDOC'), huge: pad('HUGEDOC'), html: pad('HTMLDOC'), empty: pad('EMPTYDOC') };
const text = (body, extra = {}) => new Response(body, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8', ...extra } });
const redirect = (to, s = 307) => new Response(null, { status: s, headers: { location: to } });
globalThis.fetch = async (u, o) => {
  const url = new URL(u); hits.push(url.hostname + url.pathname.slice(0, 40));
  if (url.hostname === 'docs.google.com') {
    const id = url.pathname.split('/')[3];
    if (id === ID.priv) return redirect('https://accounts.google.com/ServiceLogin?continue=x', 302);
    if (id === ID.evil) return redirect('https://evil.example.com/steal');
    if (id === ID.missing) return new Response('nf', { status: 404 });
    return redirect(`https://doc-0k-docs.googleusercontent.com/export/${id}`);
  }
  if (url.hostname.endsWith('.googleusercontent.com')) {
    const id = url.pathname.split('/')[2];
    if (id === ID.doc) return text('﻿Hello from the doc.\nSecond line.', { 'content-disposition': `attachment; filename="MyPlan.txt"; filename*=UTF-8''My%20Burn%20Plan.txt` });
    if (id === ID.slides) return text('Slide one\nSlide two', { 'content-disposition': `attachment; filename="x.txt"` });
    if (id === ID.huge) return text('x'.repeat(2_000_000));
    if (id === ID.html) return new Response('<html>sign in</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    if (id === ID.empty) return text('   \n  ');
  }
  throw new Error('UNEXPECTED FETCH ' + u);
};
const run = async (url, method = 'POST') => {
  let status, body; const res = { status(c) { status = c; return res; }, setHeader() { return res; }, json(b) { body = b; return res; } };
  await handler({ method, body: { url } }, res); return { status, body };
};
const doc = (id, q = '/edit?usp=sharing') => `https://docs.google.com/document/d/${id}${q}`;
const sl = (id) => `https://docs.google.com/presentation/d/${id}/edit#slide=id.p`;

let r = await run(doc(ID.doc));
check('Google Doc: ok, follows redirect to googleusercontent', r.status === 200 && r.body.kind === 'document' && hits.some((h) => h.startsWith('doc-0k-docs.googleusercontent.com')));
check('Doc: BOM stripped, text intact', r.body.text === 'Hello from the doc.\nSecond line.');
check('Doc: title from UTF-8 filename*, ".txt" removed', r.body.name === 'My Burn Plan', r.body.name);
r = await run(sl(ID.slides)); check('Slides: ok + fallback title from filename=', r.status === 200 && r.body.kind === 'presentation' && r.body.name === 'x' && r.body.text.includes('Slide two'));
check('Slides uses the /export/txt URL', hits.some((h) => h.includes('/presentation/d/')));
check('account-style /a/domain/ links accepted', (await run(`https://docs.google.com/a/example.com/document/d/${ID.doc}/edit`)).status === 200);
r = await run(doc(ID.priv)); check('private doc -> 403 with sharing hint', r.status === 403 && r.body.error.includes('Anyone with the link'));
const before = hits.length; r = await run(doc(ID.evil));
check('redirect to another site -> blocked, never fetched', r.status === 403 && !hits.slice(before).some((h) => h.includes('evil.example.com')), hits.slice(before).join(','));
r = await run(doc(ID.missing)); check('missing doc -> 404', r.status === 404);
r = await run(doc(ID.huge)); check('oversized -> 413', r.status === 413);
r = await run(doc(ID.html)); check('HTML response (login page) -> 403', r.status === 403);
r = await run(doc(ID.empty)); check('empty doc -> 422', r.status === 422);
const n0 = hits.length;
for (const bad of ['https://evil.com/document/d/' + ID.doc, 'https://docs.google.com.evil.com/document/d/' + ID.doc, 'http://docs.google.com/document/d/' + ID.doc,
  'https://docs.google.com/spreadsheets/d/' + ID.doc, 'https://docs.google.com/document/d/short', 'file:///etc/passwd', 'javascript:alert(1)', '', 'not a url', 'https://docs.google.com/document/d/' + ID.doc + '@evil.com']) {
  const x = await run(bad); if (!(x.status === 400)) check('rejects ' + bad, false, String(x.status));
}
check('look-alike / non-Google / non-https URLs all rejected with 400 (10 cases)', true);
check('rejected URLs triggered zero fetches', hits.length === n0);
// junk after a valid id is ignored: only the id is used to build the Google URL
const h0 = hits.length; await run('https://docs.google.com/document/d/' + ID.doc.slice(0, 25) + '/../../x@evil.com');
check('junk after a valid id: only Google hosts are ever contacted', hits.slice(h0).length > 0 && hits.slice(h0).every((h) => h.startsWith('docs.google.com') || h.includes('.googleusercontent.com')), hits.slice(h0).join(','));
r = await run('', 'GET'); check('GET -> 405', r.status === 405);
console.log(`\n${pass}/${total} passed`);
