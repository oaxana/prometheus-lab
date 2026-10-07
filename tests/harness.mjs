// Local test harness: serves public/, mounts the real api/ handlers, fakes Supabase REST + Anthropic.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { ROOT } from './lib.mjs';
const PORT = 4173;
process.env.ANTHROPIC_API_KEY = 'sk-test';
process.env.ANTHROPIC_BASE_URL = `http://localhost:${PORT}/anthropic`;
process.env.SUPABASE_URL = `http://localhost:${PORT}/supabase`;
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-test';
process.env.ADMIN_KEY = 'letmein';

const summarize = (await import(`${ROOT}/api/summarize.js`)).default;
const synthesize = (await import(`${ROOT}/api/synthesize.js`)).default;
const googleDoc = (await import(`${ROOT}/api/google-doc.js`)).default;
const mapPillars = (await import(`${ROOT}/api/map-pillars.js`)).default;
const testPersonaSubmit = (await import(`${ROOT}/api/test-persona-submit.js`)).default;
const metrics = (await import(`${ROOT}/api/metrics.js`)).default;
const suggestedPillars = (await import(`${ROOT}/api/suggested-pillars.js`)).default;
// Fake Google: only the google hosts are intercepted; everything else (Anthropic fake, Supabase fake) goes to the real fetch.
const realFetch = globalThis.fetch;
const gText = (body, h = {}) => new Response(body, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8', ...h } });
globalThis.fetch = async (u, o) => {
  const url = new URL(typeof u === 'string' ? u : (u.url ?? String(u)));
  if (url.hostname === 'docs.google.com') {
    const id = url.pathname.split('/')[3];
    if (id.startsWith('PRIVATE')) return new Response(null, { status: 302, headers: { location: 'https://accounts.google.com/ServiceLogin' } });
    return new Response(null, { status: 307, headers: { location: `https://doc-0k-docs.googleusercontent.com/export/${id}` } });
  }
  if (url.hostname.endsWith('.googleusercontent.com')) {
    return url.pathname.includes('SLIDES')
      ? gText('Deck slide A\nDeck slide B talks about GOOGLESLIDES-MARKER', { 'content-disposition': "attachment; filename*=UTF-8''Camp%20Deck.txt" })
      : gText('GOOGLEDOC-MARKER: composting must be mandatory.', { 'content-disposition': "attachment; filename*=UTF-8''Camp%20Plan.txt" });
  }
  return realFetch(u, o);
};

const db = { submissions: [], discovery: [], objects: [], synthesis: null, participants: new Map(), authUsers: new Map(), refreshTokens: new Map() };
let mapMode = 'ok'; // 'ok' | 'fail'
let metricsMode = 'ok'; // 'ok' | 'fail'
let synthMode = 'full'; // 'full' | 'sparse' (sparse: out-of-range numbers, empty fields)
let mapIdeas = ['AI-free quiet hours at every camp']; // what the fake model reports as "new ideas" (set with /__idea?v=a|b)
export const log = [];
let anthropicMode = 'ok'; // 'ok' | 'reject-attachments' | 'refusal'

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });
const readBuf = (req) => new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });
const json = (res, status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };

function vercelRes(res) {
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(b)); return res; };
  return res;
}

function sse(res, events) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const [type, data] of events) res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  res.end();
}

async function fakeAnthropic(req, res, body) {
  const b = JSON.parse(body);
  log.push({ anthropic: b });
  if (anthropicMode === 'refusal') {
    return json(res, 200, { id: 'm', type: 'message', role: 'assistant', model: b.model, content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'general_harms' }, usage: { input_tokens: 1, output_tokens: 0 } });
  }
  const hasAttach = Array.isArray(b.messages[0].content) && b.messages[0].content.some((c) => c.type === 'image' || c.type === 'document');
  if (anthropicMode === 'reject-attachments' && hasAttach) {
    return json(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'bad image' } });
  }
  const props = b.output_config?.format?.schema?.properties ?? {};
  let out;
  if (props.matched_pillars) {
    if (mapMode === 'fail') return json(res, 500, { type: 'error', error: { type: 'api_error', message: 'boom' } });
    out = { matched_pillars: [3, 1, 99, 3], new_ideas: mapIdeas, reasoning: 'Mentions access and consent.' };
  }
  else if (props.commons) {
    const prompt = b.messages[0].content;
    const sourceLabels = [...new Set([...prompt.matchAll(/source="([^"]+)"/g)].map((m) => m[1]))];
    const [a, bb = a, c = a, d = a] = sourceLabels;
    const shortD = d.match(/^Participant [A-Z]+/)?.[0]?.toLowerCase() || d;
    if (synthMode === 'sparse') out = { commons: [{ pillarId: 2, strength: 'moderate', consensus: 150, themes: [], quotes: [], nuance: '', points: [{ point: 'p', voices: [a] }] }, { pillarId: 4, strength: 'bogus', consensus: -5, themes: ['x'.repeat(100)], quotes: ['q1', 'q2', 'q3'], nuance: '', points: [{ point: 'p4', voices: [c] }] }], contested: [{ pillarId: 3, spectrum: { left: '', right: 'x' }, positions: [{ stance: 's1', value: -20, voices: [a] }, { stance: 's2', value: 300, voices: [c] }], tension: '' }], gaps: [{ pillarId: 5, note: 'n', suggestions: ['1', '2', '3', '4', '5'] }] };
    else out = {
    commons: [{ pillarId: 10, strength: 'strong', consensus: 90, themes: ['Disclosure first', 'No deepfakes'], quotes: ['AI must say what it is. <u>Always</u>.'], nuance: 'Agreement is <i>strongest</i> on disclosure.', points: [
      { point: 'Everyone wants <b>disclosure</b>.', voices: [c, a, d, 'Invented source'] },
      { point: `No deepfakes, says ${shortD}.`, voices: [a, d] }] }],
    contested: [{ pillarId: 1, spectrum: { left: 'Strict opt-in', right: 'Signage + opt-out' }, positions: [{ stance: 'Strict opt-in', value: 10, voices: [c] }, { stance: 'Signage + opt-out', value: 80, voices: [a, bb] }], tension: 'Consent vs practicality' }],
    gaps: [{ pillarId: 6, note: 'Nobody spoke to <i>environment</i>.', suggestions: ['Digital <b>MOOP</b> rules', 'Energy budgets for AI on playa'] }, { pillarId: 11, note: 'Default world is unaddressed.', suggestions: [] }] };
  }
  else if (props.pillars) out = { pillars: [3, 1, 99, 3], summary: 'A short summary.' };
  else out = { summary: 'A short summary.' };
  const text = JSON.stringify(out);
  const message = { id: 'msg_1', type: 'message', role: 'assistant', model: b.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } };
  if (b.stream) {
    return sse(res, [
      ['message_start', { message }],
      ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { index: 0, delta: { type: 'text_delta', text } }],
      ['content_block_stop', { index: 0 }],
      ['message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }],
      ['message_stop', {}],
    ]);
  }
  json(res, 200, { ...message, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } });
}

const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwtFor = (user) => `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ sub: user.id, aud: 'authenticated', role: 'authenticated', email: user.email, exp: Math.floor(Date.now()/1000)+3600 })}.x`;
const authUser = (req) => {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token.includes('.')) return null;
  try { const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url')); return [...db.authUsers.values()].find((u) => u.id === payload.sub) || null; }
  catch { return null; }
};
const sessionFor = (user) => {
  const refresh_token = `refresh-${user.id}`;
  db.refreshTokens.set(refresh_token, user.id);
  return { access_token: jwtFor(user), token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now()/1000)+3600, refresh_token, user };
};
async function fakeAuth(req, res, url, body) {
  const p = url.pathname.replace('/supabase/auth/v1', '');
  const input = body ? JSON.parse(body) : {};
  if (p === '/otp' && req.method === 'POST') return json(res, 200, {});
  if (p === '/verify' && req.method === 'POST') {
    const email = String(input.email || '').toLowerCase();
    if (!email || String(input.token) !== '123456') return json(res, 403, { msg: 'Invalid verification code' });
    let user = db.authUsers.get(email);
    if (!user) {
      const now = new Date().toISOString();
      user = { id: randomUUID(), aud: 'authenticated', role: 'authenticated', email, email_confirmed_at: now, app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {}, created_at: now, updated_at: now };
      db.authUsers.set(email, user);db.participants.set(user.id, { display_name: '' });
    }
    return json(res, 200, sessionFor(user));
  }
  if (p === '/token' && req.method === 'POST') {
    const id = db.refreshTokens.get(input.refresh_token);
    const user = [...db.authUsers.values()].find((u) => u.id === id);
    return user ? json(res, 200, sessionFor(user)) : json(res, 400, { msg: 'Invalid refresh token' });
  }
  if (p === '/user' && req.method === 'GET') {
    const user = authUser(req);return user ? json(res, 200, user) : json(res, 401, { msg: 'Not authenticated' });
  }
  if (p === '/logout' && req.method === 'POST') return json(res, 204, {});
  return json(res, 404, { msg: `unknown auth route ${p}` });
}

// Storage fake: private bucket, one folder per participant (mirrors the policies in supabase-setup.sql).
async function fakeStorage(req, res, url) {
  const p = decodeURIComponent(url.pathname.replace('/supabase/storage/v1', ''));
  const user = authUser(req);
  const denied = () => json(res, 403, { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' });
  log.push({ storage: req.method + ' ' + p });
  if (!user) return denied();
  const mine = (path) => path.startsWith(user.id + '/');
  if (req.method === 'POST' && p.startsWith('/object/sign/')) {
    const path = p.replace('/object/sign/submission-files/', '');
    if (!mine(path) || !db.objects.some((o) => o.path === path)) return json(res, 400, { message: 'Object not found' });
    return json(res, 200, { signedURL: `/object/sign/submission-files/${path}?token=t` });
  }
  if (req.method === 'POST' && p.startsWith('/object/submission-files/')) {
    const path = p.replace('/object/submission-files/', ''), buf = await readBuf(req);
    if (!mine(path)) return denied();
    if (db.objects.some((o) => o.path === path)) return json(res, 409, { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' });
    const text = buf.toString('latin1');
    const type = (text.match(/name="";[^\r\n]*\r\nContent-Type: ([^\r\n]+)/i) || [])[1] || req.headers['content-type'];
    db.objects.push({ path, owner: user.id, type, size: buf.length });
    return json(res, 200, { Id: randomUUID(), Key: 'submission-files/' + path });
  }
  if (req.method === 'DELETE' && p === '/object/submission-files') {
    const { prefixes = [] } = JSON.parse(await readBody(req) || '{}');
    db.objects = db.objects.filter((o) => !(prefixes.includes(o.path) && mine(o.path)));
    return json(res, 200, []);
  }
  json(res, 404, { message: 'not found ' + p });
}

async function fakeSupabase(req, res, url, body) {
  const p = url.pathname.replace('/supabase/rest/v1', '');
  log.push({ supabase: req.method + ' ' + p });
  const user = authUser(req);
  if (p === '/rpc/list_submissions') {
    const { p_test_uid } = JSON.parse(body || '{}');
    const rows = [...db.submissions].reverse().map((s) => ({
      id: s.id, pillars: s.pillars, summary: s.summary, auto_tagged: s.auto_tagged, is_test: s.is_test, display_name: s.display_name,
      timestamp: s.ts,
      mine: (!!user && s.participant_id === user.id) || (!s.participant_id && s.is_test && !!p_test_uid && s.uid === p_test_uid),
      content: (!!user && s.participant_id === user.id) ? s.content : null,
      pillar_choice: s.pillar_choice || 'selected',
      ...(!!user && s.participant_id === user.id
        ? { contribution_type: s.contribution_type ?? null, input_mode: s.input_mode || 'text', audio_url: s.audio_url ?? null, file_url: s.file_url ?? null, file_name: s.file_name ?? null,
            discovery_audio_url: db.discovery.find((d) => d.id === s.discovery_input_id)?.audio_url ?? null }
        : { contribution_type: null, input_mode: null, audio_url: null, file_url: null, file_name: null, discovery_audio_url: null }),
    }));
    return json(res, 200, rows);
  }
  if (p === '/rpc/set_my_display_name') {
    if (!user) return json(res, 401, { message: 'Authentication required' });
    const name = String(JSON.parse(body || '{}').p_display_name || '').trim();
    if (!name || name.length > 80) return json(res, 400, { message: 'Display name must be 1 to 80 characters.' });
    db.participants.set(user.id, { display_name: name });
    db.submissions.filter((s) => s.participant_id === user.id && s.display_name).forEach((s) => { s.display_name = name; });
    return json(res, 200, name);
  }
  if (p === '/rpc/submit_submission') {
    if (!user) return json(res, 401, { message: 'Authentication required' });
    const input = JSON.parse(body || '{}');const name = db.participants.get(user.id)?.display_name || '';
    if (!input.p_anonymous && !name) return json(res, 400, { message: 'Set a display name before submitting by name.' });
    const own = (p) => p == null || p.startsWith(user.id + '/');
    if (!own(input.p_audio_url) || !(own(input.p_file_url) || /^https:\/\/docs\.google\.com\//.test(input.p_file_url))) return json(res, 403, { message: 'File must be in your own storage folder.' });
    const disc = input.p_discovery_input_id ? db.discovery.find((d) => d.id === input.p_discovery_input_id && d.participant_id === user.id) : null;
    if (input.p_discovery_input_id && !disc) return json(res, 403, { message: 'Unknown discovery input.' });
    if (disc) { disc.is_anonymous = input.p_anonymous !== false; disc.is_test = !!input.p_is_test; }
    db.submissions.push({ id: randomUUID(), ts: Date.now(), pillars: input.p_pillars || [], content: input.p_content, summary: input.p_summary || '', auto_tagged: !!input.p_auto_tagged, is_test: !!input.p_is_test, participant_id: user.id, uid: null, display_name: input.p_anonymous ? '' : name,
      contribution_type: (input.p_contribution_type || '').trim() || null, input_mode: input.p_input_mode || 'text', pillar_choice: input.p_pillar_choice || 'selected',
      audio_url: input.p_audio_url ?? null, file_url: input.p_file_url ?? null, file_name: input.p_file_name ?? null, discovery_input_id: input.p_discovery_input_id ?? null });
    return json(res, 200, db.submissions.at(-1).id);
  }
  if (p === '/rpc/save_discovery_input') {
    if (!user) return json(res, 401, { message: 'Authentication required' });
    const i = JSON.parse(body || '{}');
    if (i.p_audio_url && !i.p_audio_url.startsWith(user.id + '/')) return json(res, 403, { message: 'Recording must be in your own storage folder.' });
    const fields = { input_text: i.p_input_text, input_type: i.p_input_type || 'text', audio_url: i.p_audio_url ?? null, ai_mapping: i.p_ai_mapping ?? null, is_anonymous: i.p_is_anonymous !== false, is_test: !!i.p_is_test };
    if (!i.p_id) { const row = { id: randomUUID(), participant_id: user.id, ...fields }; db.discovery.push(row); return json(res, 200, row.id); }
    const row = db.discovery.find((d) => d.id === i.p_id && d.participant_id === user.id);
    if (!row) return json(res, 403, { message: 'Unknown discovery input.' });
    Object.assign(row, fields); return json(res, 200, row.id);
  }
  if (p === '/rpc/update_my_submission') {
    const i = JSON.parse(body || '{}');
    const row = db.submissions.find((x) => x.id === i.p_id && user && x.participant_id === user.id);
    if (row) { row.content = i.p_content; row.summary = i.p_summary || ''; row.contribution_type = (i.p_contribution_type || '').trim() || null; }
    return json(res, 200, !!row);
  }
  if (p === '/rpc/set_my_submission_test') {
    const { p_id, p_is_test } = JSON.parse(body || '{}');
    const row = db.submissions.find((x) => x.id === p_id && user && x.participant_id === user.id);
    if (row) { row.is_test = !!p_is_test; const d = db.discovery.find((x) => x.id === row.discovery_input_id); if (d) d.is_test = !!p_is_test; }
    return json(res, 200, !!row);
  }
  if (p === '/rpc/delete_my_submission') {
    const { p_id } = JSON.parse(body || '{}');
    const i = db.submissions.findIndex((x) => x.id === p_id && user && x.participant_id === user.id);
    if (i >= 0) { const [gone] = db.submissions.splice(i, 1); db.discovery = db.discovery.filter((d) => d.id !== gone.discovery_input_id); }
    return json(res, 200, i >= 0);
  }
  if (p === '/participants' && req.method === 'GET' && req.headers.apikey === 'service-test') {   // service role: every participant (filters are ignored)
    return json(res, 200, [...db.participants].map(([id, v]) => ({ id, display_name: v.display_name })));
  }
  if (p === '/pillar_discovery_inputs' && req.method === 'GET') {
    if (req.headers.apikey !== 'service-test') return json(res, 401, { message: 'Service role required' });
    return json(res, 200, db.discovery);
  }
  if (p === '/participants' && req.method === 'GET') {
    if (!user) return json(res, 200, []);
    return json(res, 200, [{ display_name: db.participants.get(user.id)?.display_name || '' }]);
  }
  if (p === '/submissions' && req.method === 'POST') {
    if (req.headers.apikey !== 'service-test') return json(res, 401, { message: 'Direct inserts are disabled' });
    const row = JSON.parse(body);
    db.submissions.push({ id: randomUUID(), ts: Date.now(), ...row });
    res.writeHead(201); return res.end();
  }
  if (p === '/submissions' && req.method === 'DELETE') {
    if (req.headers.apikey !== 'service-test') return json(res, 401, { message: 'Service role required' });
    const value = (name, prefix) => String(url.searchParams.get(name) || '').replace(prefix, '');
    const id = value('id', /^eq\./), uid = value('uid', /^eq\./);
    const i = db.submissions.findIndex((s) => s.id === id && s.uid === uid && !s.participant_id && s.is_test === true);
    const deleted = i >= 0 ? db.submissions.splice(i, 1) : [];
    return json(res, 200, deleted.map((s) => ({ id: s.id })));
  }
  if (p === '/submissions' && req.method === 'GET') {
    return json(res, 200, db.submissions.map((s) => ({ id:s.id,pillars: s.pillars, pillar_choice: s.pillar_choice || 'selected', content: s.content, summary: s.summary, is_test: s.is_test, created_at: new Date(s.ts).toISOString(), display_name: s.display_name, uid: s.uid, participant_id:s.participant_id, discovery_input_id: s.discovery_input_id ?? null })));
  }
  if (p === '/synthesis' && req.method === 'GET') {
    return json(res, 200, db.synthesis ? [db.synthesis] : []); // PostgREST array mode, as supabase-js maybeSingle() sends
  }
  if (p === '/synthesis' && req.method === 'POST') {
    db.synthesis = JSON.parse(body); res.writeHead(201); return res.end();
  }
  json(res, 404, { message: 'not found ' + p });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname === '/__mode') { anthropicMode = url.searchParams.get('m'); return json(res, 200, { anthropicMode }); }
    if (url.pathname === '/__log') return json(res, 200, log);
    if (url.pathname === '/__db') return json(res, 200, db);
    if (url.pathname.startsWith('/anthropic/')) return fakeAnthropic(req, res, await readBody(req));
    if (url.pathname === '/__metrics') { metricsMode = url.searchParams.get('m'); return json(res, 200, { metricsMode }); }
    if (url.pathname === '/__synth') { synthMode = url.searchParams.get('m'); return json(res, 200, { synthMode }); }
    if (url.pathname === '/__idea') { mapIdeas = (url.searchParams.get('v') || '').split('|').filter(Boolean); return json(res, 200, { mapIdeas }); }
    if (url.pathname === '/__map') { mapMode = url.searchParams.get('m'); return json(res, 200, { mapMode }); }
    if (url.pathname.startsWith('/supabase/storage/v1/')) return fakeStorage(req, res, url);
    if (url.pathname.startsWith('/supabase/auth/v1/')) return fakeAuth(req, res, url, await readBody(req));
    if (url.pathname.startsWith('/supabase/')) return fakeSupabase(req, res, url, await readBody(req));
    if (url.pathname === '/api/suggested-pillars') return suggestedPillars(req, vercelRes(res));
    if (url.pathname === '/api/metrics') {
      if (metricsMode === 'fail') return json(res, 500, { error: 'down' });
      return metrics(req, vercelRes(res));
    }
    if (url.pathname === '/api/summarize' || url.pathname === '/api/map-pillars' || url.pathname === '/api/synthesize' || url.pathname === '/api/google-doc' || url.pathname === '/api/test-persona-submit') {
      const raw = await readBody(req);
      req.body = raw ? JSON.parse(raw) : undefined;
      const handler=url.pathname.endsWith('map-pillars')?mapPillars:url.pathname.endsWith('summarize')?summarize:url.pathname.endsWith('google-doc')?googleDoc:url.pathname.endsWith('test-persona-submit')?testPersonaSubmit:synthesize;
      return handler(req, vercelRes(res));
    }
    if (url.pathname === '/config.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      return res.end(`window.PROMETHEUS_LAB_CONFIG={SUPABASE_URL:'http://localhost:${PORT}/supabase',SUPABASE_ANON_KEY:'anon-test'};`);
    }
    let f = path.join(ROOT, 'public', url.pathname === '/' ? 'index.html' : url.pathname);
    if (!f.startsWith(path.join(ROOT, 'public')) || !fs.existsSync(f)) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'text/plain' });
    res.end(fs.readFileSync(f));
  } catch (e) { console.error(e); json(res, 500, { error: String(e) }); }
}).listen(PORT, () => console.log('harness on', PORT));
