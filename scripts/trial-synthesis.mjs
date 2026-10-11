// Try a synthesis on the real data WITHOUT saving a version: same code path as Admin -> Create new synthesis
// (Opus synthesis + Sonnet fact-check), but the result only goes to a git-ignored file for review.
//
//   node --env-file=.env.local scripts/trial-synthesis.mjs
//
// Reads Supabase (service-role key) and calls Claude (costs a little; the script prints the cost). Writes nothing
// to the database. Output: backups/trial-synthesis-<time>.json (git-ignored: it holds public names) with the result
// before and after the fact-check, plus timing and token usage.
import fs from 'node:fs';
import path from 'node:path';
import { anthropic } from '../api/_shared.js';
import { supabase, gather, runSynthesis } from '../api/synthesize.js';

// USD per million tokens (input, output), from the Anthropic price list as of 2026-10.
const PRICES = { 'claude-opus-5-5': [4, 20], 'claude-sonnet-5-5': [2, 10] };

// Record token usage of every Claude call this run makes.
const usage = [];
const client = anthropic();
const stream = client.messages.stream.bind(client.messages);
client.messages.stream = (params, options) => {
  const s = stream(params, options);
  const finalMessage = s.finalMessage.bind(s);
  s.finalMessage = async () => {
    const m = await finalMessage();
    usage.push({ model: params.model, at: Date.now(), input: m.usage.input_tokens, output: m.usage.output_tokens });
    return m;
  };
  return s;
};

const started = Date.now();
const g = await gather(supabase(), false);
console.log(`Read ${g.voices.length} contributions from ${g.personKeys.length} voices. Running the synthesis (Opus) …`);
const { result, checked, unchecked } = await runSynthesis(g, { keepUnchecked: true });
const total = (Date.now() - started) / 1000;
const synthDone = usage.find((u) => u.model === 'claude-opus-5-5')?.at ?? Date.now();

// What the fact-check removed: names credited before, gone after.
const removed = [];
const compare = (kind, before, after, textOf) =>
  before.forEach((c, ci) => (c[kind] ?? []).forEach((item, i) => {
    const kept = new Set(after[ci]?.[kind]?.[i]?.voices ?? []);
    for (const v of item.voices ?? []) if (!kept.has(v)) removed.push(`${c.pillar}: "${textOf(item)}" — removed ${v}`);
  }));
compare('points', unchecked.commons, result.commons, (x) => x.point);
compare('positions', unchecked.contested, result.contested, (x) => x.stance);

const cost = usage.reduce((sum, u) => {
  const [inP, outP] = PRICES[u.model] ?? [0, 0];
  return sum + (u.input * inP + u.output * outP) / 1e6;
}, 0);
const byModel = (m) => usage.filter((u) => u.model === m).reduce((a, u) => ({ calls: a.calls + 1, input: a.input + u.input, output: a.output + u.output }), { calls: 0, input: 0, output: 0 });

const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
const file = path.resolve(import.meta.dirname, '..', 'backups', `trial-synthesis-${stamp}.json`);
fs.writeFileSync(file, JSON.stringify({ createdAt: new Date().toISOString(), seconds: total, factCheck: checked, usage, cost, removed, unchecked, result }, null, 2));

console.log(`\nDone in ${total.toFixed(0)} s (synthesis ${((synthDone - started) / 1000).toFixed(0)} s, fact-check ${((Date.now() - synthDone) / 1000).toFixed(0)} s).`);
console.log(`Opus: ${JSON.stringify(byModel('claude-opus-5-5'))}  Sonnet checks: ${JSON.stringify(byModel('claude-sonnet-5-5'))}`);
console.log(`Estimated cost: $${cost.toFixed(2)}`);
console.log(`Commons ${result.commons.length}, contested ${result.contested.length}, gaps ${result.gaps.length}. Fact-check: ${JSON.stringify(checked)}`);
console.log(`\nCredits removed by the fact-check (${removed.length}):`);
for (const r of removed) console.log(' - ' + r);
console.log(`\nNothing was saved to the database. Full result: backups/${path.basename(file)}`);
