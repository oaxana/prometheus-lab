// Try a synthesis on the real data WITHOUT saving a version: the same Opus synthesis as Admin -> Create new synthesis,
// then each fact-checker in CHECKERS on that same output, so they can be compared. Results only go to a git-ignored file.
//
//   node --env-file=.env.local scripts/trial-synthesis.mjs
//
// Reads Supabase (service-role key) and calls Claude (costs a little; the script prints the cost). Writes nothing
// to the database. Output: backups/trial-synthesis-<time>.json (git-ignored: it holds public names) with the result
// before and after the fact-check, plus timing and token usage.
import fs from 'node:fs';
import path from 'node:path';
import { anthropic } from '../api/_shared.js';
import { supabase, gather, synthesizeRaw, factCheck, clean } from '../api/synthesize.js';

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

// Checkers to compare on the SAME synthesis output (the live app uses the first one).
const CHECKERS = [
  { name: 'Sonnet high', model: 'claude-sonnet-5-5', effort: 'high' },
  { name: 'Opus medium', model: 'claude-opus-5-5', effort: 'medium' },
];
const costOf = (list) => list.reduce((sum, u) => {
  const [inP, outP] = PRICES[u.model] ?? [0, 0];
  return sum + (u.input * inP + u.output * outP) / 1e6;
}, 0);

const g = await gather(supabase(), false);
console.log(`Read ${g.voices.length} contributions from ${g.personKeys.length} voices. Running the synthesis (Opus) …`);
let t = Date.now();
const raw = await synthesizeRaw(g);
const synth = { seconds: (Date.now() - t) / 1000, cost: costOf(usage) };
const unchecked = clean(structuredClone(raw), g.sources);

// Credits the fact-check removed: names credited before, gone after.
function removedBy(after) {
  const out = [];
  const compare = (kind, before, aft, textOf) =>
    before.forEach((c, ci) => (c[kind] ?? []).forEach((item, i) => {
      const kept = new Set(aft[ci]?.[kind]?.[i]?.voices ?? []);
      for (const v of item.voices ?? []) if (!kept.has(v)) out.push(`${c.pillar}: "${textOf(item)}" — removed ${v}`);
    }));
  compare('points', unchecked.commons, after.commons, (x) => x.point);
  compare('positions', unchecked.contested, after.contested, (x) => x.stance);
  return out;
}

const runs = [];
for (const ck of CHECKERS) {
  const n = usage.length; t = Date.now();
  const copy = structuredClone(raw);
  const stats = await factCheck(copy, g.voices, g.rowSources, { model: ck.model, effort: ck.effort });
  const result = clean(copy, g.sources);
  runs.push({ ...ck, seconds: (Date.now() - t) / 1000, cost: costOf(usage.slice(n)), stats, removed: removedBy(result), result });
}

const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
const file = path.resolve(import.meta.dirname, '..', 'backups', `trial-synthesis-${stamp}.json`);
fs.writeFileSync(file, JSON.stringify({ createdAt: new Date().toISOString(), synth, usage, unchecked, runs }, null, 2));

console.log(`\nSynthesis: ${synth.seconds.toFixed(0)} s, $${synth.cost.toFixed(2)}. Commons ${unchecked.commons.length} (${unchecked.commons.reduce((a, c) => a + c.points.length, 0)} points), contested ${unchecked.contested.length}, gaps ${unchecked.gaps.length}.`);
for (const r of runs) {
  console.log(`\n=== Checker ${r.name}: ${r.seconds.toFixed(0)} s, $${r.cost.toFixed(2)}, ${JSON.stringify(r.stats)}`);
  for (const line of r.removed) console.log(' - ' + line);
}
console.log(`\nNothing was saved to the database. Full result: backups/${path.basename(file)}`);
