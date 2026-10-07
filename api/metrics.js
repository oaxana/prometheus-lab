// GET /api/metrics
// Returns: { voices, pillarsCovered, contributions }   (real, non-test contributions only)
// Public counts for the Home tab. Uses the server-side key because the submissions table is private;
// only these three numbers leave the server (no ids, text, names or emails).
import { createClient } from '@supabase/supabase-js';
import { HttpError, send, fail } from './_shared.js';

function dbClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new HttpError(500, 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set on the server.');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, { error: 'Use GET.' });
  try {
    const { data, error } = await dbClient()
      .from('submissions')
      .select('participant_id, uid, pillars, is_test')
      .eq('is_test', false)
      .limit(1000); // same cap as /api/synthesize
    if (error) throw new HttpError(500, 'Could not read submissions from Supabase.');

    const rows = data.filter((r) => r.is_test === false);
    // Real participants are counted by account id; historical pre-Auth rows fall back to their browser uid.
    const voices = new Set(rows.map((r) => r.participant_id ?? r.uid).filter(Boolean));
    const pillars = new Set(rows.flatMap((r) => r.pillars ?? []).filter((n) => Number.isInteger(n) && n >= 1 && n <= 12));
    return send(res, 200, { voices: voices.size, pillarsCovered: pillars.size, contributions: rows.length });
  } catch (err) {
    return fail(res, err);
  }
}
