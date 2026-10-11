// GET /api/metrics
// Returns: { voices, pillarsCovered, contributions }   (real, non-test contributions only)
// pillarsCovered is the latest synthesis's number (pillars with common ground or contested findings, i.e. not
// gaps), the same figure the Synthesis tab shows; 0 before the first synthesis. It changes only when a new version is created.
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
      .select('id, participant_id, uid, pillars, is_test, source_id')
      .eq('is_test', false)
      .limit(1000); // same cap as /api/synthesize
    if (error) throw new HttpError(500, 'Could not read submissions from Supabase.');

    const rows = data.filter((r) => r.is_test === false);
    // Legacy rows use their Auth owner/browser uid. Source-model rows use the
    // linked voice/author identity instead, so an uploader cannot inflate a
    // transcript and multiple papers by one author still count once.
    const voices = new Set();
    const sourceRows = rows.filter((r) => r.source_id);
    if (sourceRows.length) {
      const { data: links, error: linksError } = await dbClient()
        .from('submission_contributors')
        .select('submission_id, source_contributors(id, contributor_id, contributors(id, participant_id))')
        .in('submission_id', sourceRows.map((r) => r.id));
      if (linksError) throw new HttpError(500, 'Could not read source contributor links from Supabase.');
      const linkedRows = new Set();
      for (const link of links ?? []) {
        linkedRows.add(link.submission_id);
        const sc = link.source_contributors;
        const contributor = sc?.contributors;
        if (contributor?.participant_id) voices.add(`auth:${contributor.participant_id}`);
        else if (contributor?.id) voices.add(`contributor:${contributor.id}`);
        else if (sc?.id) voices.add(`source-contributor:${sc.id}`);
      }
      // A malformed/incomplete source link should not erase a contribution from
      // the count; retain the old conservative identity fallback for that row.
      for (const r of sourceRows) if (!linkedRows.has(r.id)) voices.add(`fallback:${r.participant_id ?? r.uid ?? r.id}`);
    }
    // Same keys as api/synthesize.js, so one account's old rows and new source rows count once.
    for (const r of rows.filter((r) => !r.source_id)) {
      if (r.participant_id) voices.add(`auth:${r.participant_id}`);
      else if (r.uid) voices.add(`legacy:${r.uid}`);
    }
    const { data: latest, error: synError } = await dbClient()
      .from('synthesis_versions')
      .select('commons, contested')
      .order('version', { ascending: false })
      .limit(1);
    if (synError) throw new HttpError(500, 'Could not read the latest synthesis from Supabase.');
    const syn = latest?.[0];
    // Same rule as the Synthesis tab's "Pillars covered" (renderSynthesisResult in public/app.js).
    const pillars = new Set([...(syn?.commons ?? []), ...(syn?.contested ?? [])].map((c) => c.pillarId ?? c.pillar));
    return send(res, 200, { voices: voices.size, pillarsCovered: pillars.size, contributions: rows.length });
  } catch (err) {
    return fail(res, err);
  }
}
