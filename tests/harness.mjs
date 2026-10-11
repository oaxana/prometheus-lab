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
process.env.ADMIN_PASSWORD = 'letmein';

const summarize = (await import(`${ROOT}/api/summarize.js`)).default;
const synthesize = (await import(`${ROOT}/api/synthesize.js`)).default;
const googleDoc = (await import(`${ROOT}/api/google-doc.js`)).default;
const mapPillars = (await import(`${ROOT}/api/map-pillars.js`)).default;
const admin = (await import(`${ROOT}/api/admin.js`)).default;
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

const db = { submissions: [], discovery: [], objects: [], synthesis: null, synthesisVersions: [], participants: new Map(), authUsers: new Map(), refreshTokens: new Map(), sources: [], contributors: [], sourceContributors: [], submissionContributors: [] };
let mapMode = 'ok'; // 'ok' | 'fail'
let metricsMode = 'ok'; // 'ok' | 'fail'
let synthMode = 'full'; // 'full' | 'sparse' (sparse: out-of-range numbers, empty fields)
let mapIdeas = ['AI-free quiet hours at every camp']; // what the fake model reports as "new ideas" (set with /__idea?v=a|b)
export const log = [];
let anthropicMode = 'ok'; // 'ok' | 'reject-attachments' | 'refusal'
let checkReject = ''; // fake fact-check: statements containing this text are "not supported" ('' = all supported)
let checkMode = 'ok'; // 'ok' | 'fail' (fact-check calls error out)

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
    commons: [{ pillarId: 8, strength: 'strong', consensus: 90, themes: ['Disclosure first', 'No deepfakes'], quotes: ['AI must say what it is. <u>Always</u>.'], nuance: 'Agreement is <i>strongest</i> on disclosure.', points: [
      { point: 'Everyone wants <b>disclosure</b>.', voices: [c, a, d, 'Invented source'] },
      { point: `No deepfakes, says ${shortD}.`, voices: [a, d] }] }],
    contested: [{ pillarId: 1, spectrum: { left: 'Strict opt-in', right: 'Signage + opt-out' }, positions: [{ stance: 'Strict opt-in', value: 10, voices: [c] }, { stance: 'Signage + opt-out', value: 80, voices: [a, bb] }], tension: 'Consent vs practicality' }],
    gaps: [{ pillarId: 7, note: 'Nobody spoke to <i>environment</i>.', suggestions: ['Digital <b>MOOP</b> rules', 'Energy budgets for AI on playa'] }, { pillarId: 2, note: 'Coexistence is unaddressed.', suggestions: [] }] };
  }
  else if (props.results) {
    if (checkMode === 'fail') return json(res, 500, { type: 'error', error: { type: 'api_error', message: 'check boom' } });
    const statements = [...b.messages[0].content.matchAll(/<statement id="(\d+)"[^>]*>([^<]*)<\/statement>/g)];
    out = { results: statements.map((m) => ({ id: Number(m[1]), supported: !(checkReject && m[2].includes(checkReject)) })) };
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
      source_type: db.sources.find((x) => x.id === s.source_id)?.source_type || 'individual',
      source_title: db.sources.find((x) => x.id === s.source_id)?.title || null,
      voice_labels: db.submissionContributors.filter((x) => x.submission_id === s.id).map((x) => db.sourceContributors.find((sc) => sc.id === x.source_contributor_id)?.source_label).filter(Boolean),
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
  if (p === '/rpc/submit_source') {
    if (!user) return json(res, 401, { message: 'Authentication required' });
    const i = JSON.parse(body || {}), type = i.p_source_type;
    if (!['individual', 'transcript', 'document'].includes(type)) return json(res, 400, { message: 'Bad source type' });
    const raw = String(i.p_raw_content || '').trim(), title = String(i.p_source_title || '').trim() || (type === 'individual' ? 'Individual contribution' : '');
    if (!raw || !title) return json(res, 400, { message: 'Source title/content required' });
    const own = (v) => v == null || v.startsWith(user.id + '/');
    if (!own(i.p_audio_url) || !(own(i.p_file_url) || /^https:\/\/docs\.google\.com\//.test(i.p_file_url))) return json(res, 403, { message: 'File must be in your own storage folder.' });
    const name = db.participants.get(user.id)?.display_name || '';
    if (type === 'individual' && !i.p_anonymous && !name) return json(res, 400, { message: 'Set a display name before submitting by name.' });
    const src = { id: randomUUID(), source_type: type, uploader_participant_id: user.id, title, raw_content: raw, original_audio_url: i.p_audio_url ?? null, original_file_url: i.p_file_url ?? null, original_file_name: i.p_file_name ?? null };
    db.sources.push(src);
    const people = Array.isArray(i.p_contributors) ? i.p_contributors : [], sourcePeople = [];
    const addPerson = (label, role, detected = false) => {
      const sc = { id: randomUUID(), source_id: src.id, contributor_id: null, source_label: label, contributor_role: role, detected_from_source: detected, identity_confirmed: role === 'individual' || role === 'author', position: sourcePeople.length };
      if (role === 'individual') {
        let c = db.contributors.find((x) => x.participant_id === user.id);
        if (!c) { c = { id: randomUUID(), participant_id: user.id, identity_key: 'participant:' + user.id, display_name: i.p_anonymous ? '' : name }; db.contributors.push(c); }
        sc.contributor_id = c.id;
      }
      if (role === 'author') {
        const key = 'author:' + label.replace(/\s+/g, ' ').trim().toLowerCase(); let c = db.contributors.find((x) => x.identity_key === key);
        if (!c) { c = { id: randomUUID(), participant_id: null, identity_key: key, display_name: label }; db.contributors.push(c); }
        sc.contributor_id = c.id;
      }
      db.sourceContributors.push(sc); sourcePeople.push(sc); return sc;
    };
    if (type === 'individual') addPerson(i.p_anonymous ? 'Anonymous contribution' : name, 'individual');
    else if (type === 'transcript') (people.length ? people : [{ label: 'Unlabeled transcript', detected: false }]).forEach((v) => addPerson(String(v.label || '').trim(), 'speaker', !!v.detected));
    else (people.length ? people : [{ label: 'Unattributed document' }]).forEach((v) => addPerson(String(v.label || '').trim(), people.length ? 'author' : 'unattributed'));
    const rows = Array.isArray(i.p_contributions) ? i.p_contributions : [];
    if (!rows.length || ((type === 'individual' || type === 'document') && rows.length !== 1)) return json(res, 400, { message: 'Wrong derived row count' });
    for (const row of rows) {
      const sub = { id: randomUUID(), ts: Date.now(), pillars: row.pillars || [], content: row.content, summary: row.summary || '', auto_tagged: !!row.auto_tagged, is_test: !!i.p_is_test, participant_id: user.id, uid: null,
        display_name: type === 'individual' && !i.p_anonymous ? name : '', contribution_type: (i.p_contribution_type || '').trim() || null, input_mode: i.p_input_mode || 'text', pillar_choice: row.pillar_choice || 'selected',
        audio_url: i.p_audio_url ?? null, file_url: i.p_file_url ?? null, file_name: i.p_file_name ?? null, discovery_input_id: type === 'individual' ? i.p_discovery_input_id ?? null : null, source_id: src.id };
      db.submissions.push(sub);
      const labels = type === 'individual' ? [sourcePeople[0].source_label] : (row.labels?.length ? row.labels : (type === 'document' ? [sourcePeople[0].source_label] : []));
      for (const label of labels) { const sc = sourcePeople.find((x) => x.source_label === label); if (!sc) return json(res, 400, { message: 'Unknown source contributor' }); db.submissionContributors.push({ submission_id: sub.id, source_contributor_id: sc.id }); }
    }
    const disc = i.p_discovery_input_id ? db.discovery.find((d) => d.id === i.p_discovery_input_id && d.participant_id === user.id) : null;
    if (disc && type === 'individual') { disc.is_anonymous = i.p_anonymous !== false; disc.is_test = !!i.p_is_test; }
    return json(res, 200, src.id);
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
  if (p === '/submissions' && req.method === 'GET') {
    return json(res, 200, db.submissions.map((s) => ({ id:s.id,pillars: s.pillars, pillar_choice: s.pillar_choice || 'selected', content: s.content, summary: s.summary, is_test: s.is_test, created_at: new Date(s.ts).toISOString(), display_name: s.display_name, uid: s.uid, participant_id:s.participant_id, discovery_input_id: s.discovery_input_id ?? null, source_id: s.source_id ?? null })));
  }
  if (p === '/sources' && req.method === 'GET') return json(res, 200, db.sources.map((s) => ({ id: s.id, source_type: s.source_type })));
  if (p === '/submission_contributors' && req.method === 'GET') {
    return json(res, 200, db.submissionContributors.map((j) => {
      const sc = db.sourceContributors.find((x) => x.id === j.source_contributor_id);
      const c = db.contributors.find((x) => x.id === sc?.contributor_id);
      return { submission_id: j.submission_id, source_contributors: sc ? { id: sc.id, source_id: sc.source_id, source_label: sc.source_label, contributor_id: sc.contributor_id, contributors: c ? { id: c.id, participant_id: c.participant_id, display_name: c.display_name } : null } : null };
    }));
  }
  if (p === '/synthesis' && req.method === 'GET') {
    return json(res, 200, db.synthesis ? [db.synthesis] : []); // PostgREST array mode, as supabase-js maybeSingle() sends
  }
  if (p === '/synthesis' && req.method === 'POST') {
    db.synthesis = JSON.parse(body); res.writeHead(201); return res.end();
  }
  // Versions: browsers may only select the public columns (column grants in supabase-setup.sql).
  if (p === '/synthesis_versions' && req.method === 'GET') {
    const cols = (url.searchParams.get('select') || '*').split(',').map((c) => c.trim());
    const service = req.headers.apikey === 'service-test';
    if (!service && cols.some((c) => c === '*' || c === 'submission_ids' || c === 'voice_keys')) return json(res, 401, { code: '42501', message: 'permission denied for table synthesis_versions' });
    let rows = [...db.synthesisVersions].sort((a, b) => b.version - a.version);
    const eq = url.searchParams.get('version'); if (eq) rows = rows.filter((r) => r.version === Number(eq.replace('eq.', '')));
    const limit = Number(url.searchParams.get('limit')); if (limit) rows = rows.slice(0, limit);
    return json(res, 200, rows.map((r) => (cols.includes('*') ? r : Object.fromEntries(cols.map((c) => [c, r[c]])))));
  }
  if (p === '/synthesis_versions' && req.method === 'POST') {
    if (req.headers.apikey !== 'service-test') return json(res, 401, { message: 'Service role required' });
    const rows = [].concat(JSON.parse(body));
    if (rows.some((r) => db.synthesisVersions.some((v) => v.version === r.version))) return json(res, 409, { code: '23505', message: 'duplicate key value violates unique constraint "synthesis_versions_pkey"' });
    db.synthesisVersions.push(...rows); res.writeHead(201); return res.end();
  }
  json(res, 404, { message: 'not found ' + p });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname === '/__mode') { anthropicMode = url.searchParams.get('m'); return json(res, 200, { anthropicMode }); }
    if (url.pathname === '/__log') return json(res, 200, log);
    if (url.pathname === '/__db') return json(res, 200, db);
    if (url.pathname === '/__wipeusers') { db.authUsers.clear(); return json(res, 200, {}); } // as a server restart does: saved logins become invalid
    if (url.pathname.startsWith('/anthropic/')) return fakeAnthropic(req, res, await readBody(req));
    if (url.pathname === '/__metrics') { metricsMode = url.searchParams.get('m'); return json(res, 200, { metricsMode }); }
    // Gives the latest saved version's first finding another pillar name (e.g. one of the original 12) and back.
    if (url.pathname === '/__pillarname') { const v = db.synthesisVersions.at(-1); v.commons[0].pillar = url.searchParams.get('v'); return json(res, 200, { pillar: v.commons[0].pillar }); }
    if (url.pathname === '/__check') { checkReject = url.searchParams.get('reject') || ''; checkMode = url.searchParams.get('m') || 'ok'; return json(res, 200, { checkReject, checkMode }); }
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
    if (url.pathname === '/api/summarize' || url.pathname === '/api/map-pillars' || url.pathname === '/api/synthesize' || url.pathname === '/api/google-doc' || url.pathname === '/api/admin') {
      const raw = await readBody(req);
      req.body = raw ? JSON.parse(raw) : undefined;
      const handler=url.pathname.endsWith('map-pillars')?mapPillars:url.pathname.endsWith('summarize')?summarize:url.pathname.endsWith('google-doc')?googleDoc:url.pathname.endsWith('/admin')?admin:synthesize;
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
