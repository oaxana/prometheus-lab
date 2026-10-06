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

const db = { submissions: [], synthesis: null };
export const log = [];
let anthropicMode = 'ok'; // 'ok' | 'reject-attachments' | 'refusal'

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });
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
  if (props.commons) out = {
    commons: [{ pillarId: 10, strength: 'strong', points: [
      { point: 'Everyone wants <b>disclosure</b>.', voices: ['Me', 'Persona 2', 'Anonymous voice 1', 'Anonymous voice 2', 'Ghost Author'] },
      { point: 'No deepfakes, says Anonymous voice 2.', voices: ['Persona 2', 'Anonymous voice 1'] }] }],
    contested: [{ pillarId: 1, positions: [{ stance: 'Strict opt-in', voices: ['Me'] }, { stance: 'Signage + opt-out', voices: ['Persona 2', 'Persona 3'] }], tension: 'Consent vs practicality' }],
    gaps: [{ pillarId: 6, note: 'Nobody spoke to <i>environment</i>.' }, { pillarId: 11, note: 'Default world is unaddressed.' }] };
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

async function fakeSupabase(req, res, url, body) {
  const p = url.pathname.replace('/supabase/rest/v1', '');
  log.push({ supabase: req.method + ' ' + p });
  if (p === '/rpc/list_submissions') {
    const { p_uid } = JSON.parse(body || '{}');
    const rows = [...db.submissions].reverse().map((s) => ({
      id: s.id, pillars: s.pillars, summary: s.summary, auto_tagged: s.auto_tagged, is_test: s.is_test, display_name: s.display_name,
      timestamp: s.ts, mine: s.uid === p_uid, content: s.uid === p_uid ? s.content : null,
    }));
    return json(res, 200, rows);
  }
  if (p === '/rpc/set_my_submission_test') {
    const { p_id, p_uid, p_is_test } = JSON.parse(body || '{}');
    const row = db.submissions.find((x) => x.id === p_id && p_uid && x.uid === p_uid);
    if (row) row.is_test = !!p_is_test;
    return json(res, 200, !!row);
  }
  if (p === '/rpc/delete_my_submission') {
    const { p_id, p_uid } = JSON.parse(body || '{}');
    const i = db.submissions.findIndex((x) => x.id === p_id && p_uid && x.uid === p_uid);
    if (i >= 0) db.submissions.splice(i, 1);
    return json(res, 200, i >= 0);
  }
  if (p === '/submissions' && req.method === 'POST') {
    const row = JSON.parse(body);
    if (!row.uid || row.uid.length < 8) return json(res, 400, { message: 'check violation' });
    db.submissions.push({ id: randomUUID(), ts: Date.now(), ...row });
    res.writeHead(201); return res.end();
  }
  if (p === '/submissions' && req.method === 'GET') {
    return json(res, 200, db.submissions.map((s) => ({ pillars: s.pillars, content: s.content, summary: s.summary, is_test: s.is_test, created_at: new Date(s.ts).toISOString(), display_name: s.display_name, uid: s.uid })));
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
    if (url.pathname.startsWith('/supabase/')) return fakeSupabase(req, res, url, await readBody(req));
    if (url.pathname === '/api/summarize' || url.pathname === '/api/synthesize' || url.pathname === '/api/google-doc') {
      const raw = await readBody(req);
      req.body = raw ? JSON.parse(raw) : undefined;
      return (url.pathname.endsWith('summarize') ? summarize : url.pathname.endsWith('google-doc') ? googleDoc : synthesize)(req, vercelRes(res));
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
