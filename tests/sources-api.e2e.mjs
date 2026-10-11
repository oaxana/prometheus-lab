// Voice counting across the source model, through the real API handlers (no browser needed, but
// it runs against the fake backend like the browser suites): transcript speakers are separate
// voices, one author's several documents count once, and the uploader is not a speaker/author.
import { adminCookie } from './lib.mjs';
const B = 'http://localhost:4173'; let pass = 0, total = 0;
const check = (n, ok, x = '') => { total++; if (ok) pass++; console.log(ok ? 'PASS' : 'FAIL', n, x); };
const post = (path, body, headers = {}) => fetch(B + path, { method: 'POST', headers: { 'content-type': 'application/json', apikey: 'anon-test', ...headers }, body: JSON.stringify(body) });

const { access_token } = await (await post('/supabase/auth/v1/verify', { email: 'uploader@example.com', token: '123456', type: 'email' })).json();
const asUploader = { authorization: 'Bearer ' + access_token };
const source = async (type, title, raw, people, rows) => {
  const r = await post('/supabase/rest/v1/rpc/submit_source', { p_source_type: type, p_source_title: title, p_raw_content: raw, p_input_mode: 'text', p_contributors: people, p_contributions: rows, p_is_test: false, p_anonymous: true }, asUploader);
  if (!r.ok) throw new Error(type + ' failed: ' + (await r.text()));
};
const row = (content, labels, pillars = [1]) => ({ content, summary: 's', pillars, labels, pillar_choice: 'selected' });

await source('transcript', 'Workshop', 'Participant A: one\nParticipant B: two\nParticipant C: three',
  [{ label: 'Participant A', detected: true }, { label: 'Participant B', detected: true }, { label: 'Participant C', detected: true }],
  [row('one', ['Participant A']), row('two', ['Participant B']), row('three', ['Participant C'])]);
await source('document', 'Paper one', 'paper one text', [{ label: "Robin O'Hara" }], [row('paper one text', ["Robin O'Hara"], [3])]);
await source('document', 'Paper two', 'paper two text', [{ label: "robin  o'hara" }], [row('paper two text', ["robin  o'hara"], [4])]);
await source('document', 'Joint note', 'joint text', [{ label: "Robin O'Hara" }, { label: 'Dana Ray' }], [row('joint text', ["Robin O'Hara", 'Dana Ray'], [5])]);

// 3 speakers + Robin (3 documents) + Dana = 5 voices; 6 contribution rows; the uploader is none of them
const m1 = await (await fetch(B + '/api/metrics')).json();
check('metrics: transcript speakers are 3 voices, Aza counts once, uploader not counted', m1.voices === 5 && m1.contributions === 6, JSON.stringify(m1));
const s1 = await (await fetch(B + '/api/synthesize')).json();
check('synthesis status agrees: 5 voices, 6 contributions, all pending', s1.eligible.voices === 5 && s1.eligible.contributions === 6 && s1.pending.contributions === 6 && s1.pending.voices === 5 && s1.latestVersion === null, JSON.stringify(s1));

const cookie = await adminCookie(B);
const run = async () => (await post('/api/synthesize', {}, { cookie })).json();
const r1 = await run();
const log = await (await fetch(B + '/__log')).json();
const prompt = log.filter((x) => x.anthropic?.output_config).pop().anthropic.messages[0].content;
check('v1 is built from 6 contributions by 5 distinct participants', r1.version === 1 && r1.count === 5 && r1.submissionCount === 6 && prompt.includes('6 contributions from 5 distinct participants'), prompt.match(/\d+ contributions from \d+ distinct participants/)?.[0]);
check('v1 counts 4 sources: the transcript once, each document once', r1.sourceCount === 4, String(r1.sourceCount));
check('the co-authored document lists both authors as its participants', /participant="Participant [A-Z] \| Participant [A-Z]" source="Source \d \(document\)"/.test(prompt));
check('no uploader email, author name or speaker label reaches the model', !/uploader@|O'Hara|Dana|Workshop transcript/i.test(prompt));

// The uploader now adds their own contribution: one new contribution, one new voice
await source('individual', '', 'my own view', [], [row('my own view', [], [2])]);
const s2 = await (await fetch(B + '/api/synthesize')).json();
check('pending: 1 new contribution from 1 voice, who is new', s2.latestVersion === 1 && s2.pending.contributions === 1 && s2.pending.voices === 1 && s2.pending.newVoices === 1);
// Aza adds a third paper: one new contribution, from a voice already included
await source('document', 'Paper three', 'paper three text', [{ label: "ROBIN O'HARA" }], [row('paper three text', ["ROBIN O'HARA"], [6])]);
const s3 = await (await fetch(B + '/api/synthesize')).json();
check('pending: 2 new contributions from 2 voices, still only 1 of them new', s3.pending.contributions === 2 && s3.pending.voices === 2 && s3.pending.newVoices === 1);
const m2 = await (await fetch(B + '/api/metrics')).json();
check('metrics: 6 voices, 8 contributions', m2.voices === 6 && m2.contributions === 8, JSON.stringify(m2));
const r2 = await run();
check('v2: 6 voices, 8 contributions, nothing pending afterwards', r2.version === 2 && r2.count === 6 && r2.submissionCount === 8 && r2.pending.changed === false);

// One account = one voice under its latest name; anonymous contributions from it are still that one voice.
const wa = await (await post('/supabase/auth/v1/verify', { email: 'jamie@example.com', token: '123456', type: 'email' })).json();
const asWa = { authorization: 'Bearer ' + wa.access_token };
const mine = (text, anonymous) => post('/supabase/rest/v1/rpc/submit_source', { p_source_type: 'individual', p_source_title: '', p_raw_content: text, p_input_mode: 'text', p_contributors: [], p_contributions: [row(text, [], [7])], p_is_test: false, p_anonymous: anonymous }, asWa);
await post('/supabase/rest/v1/rpc/set_my_display_name', { p_display_name: 'Jamie' }, asWa);
await mine('first named view', false);
await post('/supabase/rest/v1/rpc/set_my_display_name', { p_display_name: 'Jamie Fox' }, asWa);
await mine('second named view', false); await mine('anonymous view one', true); await mine('anonymous view two', true);
const listed = await (await post('/supabase/rest/v1/rpc/list_submissions', {}, asWa)).json();
const waRows = listed.filter((r) => /named view|anonymous view/.test(r.content ?? ''));
check('renaming updates every earlier named contribution; anonymous ones stay anonymous', waRows.filter((r) => r.display_name === 'Jamie Fox').length === 2 && waRows.filter((r) => r.display_name === '').length === 2 && !waRows.some((r) => r.display_name === 'Jamie'));
const appJs = (await (await fetch(B + '/app.js')).text());
check('Voices cards name a person by their current name, not the label saved at submit time', appJs.includes("s.sourceType!=='individual'&&s.voiceLabels?.length"));
const s4 = await (await fetch(B + '/api/synthesize')).json();
check('4 contributions (2 named, 2 anonymous) from one account = 1 new voice', s4.pending.contributions === 4 && s4.pending.voices === 1 && s4.pending.newVoices === 1);
const r3 = await run();
const p3 = (await (await fetch(B + '/__log')).json()).filter((x) => x.anthropic?.output_config).pop().anthropic.messages[0].content;
check('synthesis: one run-local participant for all four, and the personal-chat rule is in the prompt', r3.count === 7 && p3.includes('Ignore small talk, greetings, meeting logistics') && p3.includes('Quote only statements about AI'));

// Summaries: personal-chat rule + up to 15,000 characters per text
const long = 'x'.repeat(14000) + 'END-MARKER';
await post('/api/summarize', { text: long, selectedPillars: [1] });
const sum = (await (await fetch(B + '/__log')).json()).filter((x) => x.anthropic && !x.anthropic.output_config?.format?.schema?.properties?.commons).pop().anthropic;
check('summaries get the personal-chat rule and read past the old 8,000-character cap', String(sum.system).includes('Ignore small talk') && JSON.stringify(sum.messages).includes('END-MARKER'));

console.log(`\n${pass}/${total} passed`);
