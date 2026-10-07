// GET /api/suggested-pillars
// Returns: { items: [{ idea: string, people: [{ name: string, isTest: boolean }] }] }
// Powers the Voices tab's "Suggested Pillars" list: ideas from step 2 of the wizard that Claude judged
// do NOT fit any of the 12 pillars (stored by /api/map-pillars in pillar_discovery_inputs.ai_mapping.newIdeas).
// That table has no browser read path, so this reads it with the server-side key and returns only the
// short idea phrases plus a display name per person ("Anonymous" unless they chose to be named). No ids,
// emails, raw topic text or audio paths leave the server.
import { createClient } from '@supabase/supabase-js';
import { HttpError, send, fail } from './_shared.js';

const MAX_ROWS = 1000;   // same cap as /api/metrics and /api/synthesize
const MAX_IDEA = 80;

function dbClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new HttpError(500, 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set on the server.');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

// Two phrases are "the same theme" when they match ignoring case, punctuation and spacing.
const themeKey = (s) => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export default async function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, { error: 'Use GET.' });
  try {
    const db = dbClient();
    const [links, inputs] = await Promise.all([
      db.from('submissions').select('discovery_input_id, is_test').not('discovery_input_id', 'is', null).limit(MAX_ROWS),
      db.from('pillar_discovery_inputs').select('id, participant_id, ai_mapping, is_anonymous, is_test').limit(MAX_ROWS),
    ]);
    if (links.error || inputs.error) throw new HttpError(500, 'Could not read suggested pillars from Supabase.');

    // Only answers that belong to a saved submission count (someone who abandoned the wizard leaves an orphan row).
    const submitted = new Map(links.data.map((r) => [r.discovery_input_id, r.is_test === true]));
    const rows = inputs.data.filter((r) => submitted.has(r.id) && Array.isArray(r.ai_mapping?.newIdeas));

    const named = [...new Set(rows.filter((r) => r.is_anonymous === false).map((r) => r.participant_id))];
    const names = new Map();
    if (named.length) {
      const { data, error } = await db.from('participants').select('id, display_name').in('id', named);
      if (error) throw new HttpError(500, 'Could not read suggested pillars from Supabase.');
      for (const p of data) if (p.display_name?.trim()) names.set(p.id, p.display_name.trim());
    }

    // theme -> { idea, who: Map(participant id -> { anonymous, isTest }) }; one entry per person per theme.
    const themes = new Map();
    for (const r of rows) {
      const isTest = r.is_test === true || submitted.get(r.id) === true;
      for (const raw of r.ai_mapping.newIdeas) {
        const idea = typeof raw === 'string' ? raw.trim().slice(0, MAX_IDEA) : '';
        const key = idea && themeKey(idea);
        if (!key) continue;
        if (!themes.has(key)) themes.set(key, { idea, who: new Map() });
        const who = themes.get(key).who;
        const anonymous = r.is_anonymous !== false || !names.has(r.participant_id);
        const seen = who.get(r.participant_id);
        // If the same person appears twice, stay anonymous if either row was, and real if either row was.
        who.set(r.participant_id, { anonymous: anonymous || !!seen?.anonymous, isTest: isTest && (seen ? seen.isTest : true) });
      }
    }

    const items = [...themes.values()].map(({ idea, who }) => ({
      idea,
      people: [...who.entries()]
        .map(([id, w]) => ({ name: w.anonymous ? 'Anonymous' : names.get(id), isTest: w.isTest }))
        .sort((a, b) => (a.name === 'Anonymous') - (b.name === 'Anonymous') || a.name.localeCompare(b.name)),
    }));
    items.sort((a, b) => b.people.length - a.people.length || a.idea.localeCompare(b.idea));
    return send(res, 200, { items });
  } catch (err) {
    return fail(res, err);
  }
}
