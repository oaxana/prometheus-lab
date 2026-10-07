// POST /api/test-persona-submit (project lead only — requires x-admin-key)
// Creates or deletes explicitly test-only persona rows with no participant id.
import { createClient } from '@supabase/supabase-js';
import { timingSafeEqual } from 'node:crypto';
import { HttpError, send, readJson, fail } from './_shared.js';

const PERSONAS = {
  1: { uid: 'test-persona-me', name: 'Me' },
  2: { uid: 'test-persona-2', name: 'Persona 2' },
  3: { uid: 'test-persona-3', name: 'Persona 3' },
};

function checkAdmin(req) {
  const expected = process.env.ADMIN_KEY;
  if (!expected) throw new HttpError(503, 'ADMIN_KEY is not configured on the server.');
  const given = String(req.headers['x-admin-key'] ?? '');
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new HttpError(401, 'Wrong admin key.');
}

function dbClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new HttpError(500, 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set on the server.');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST.' });
  try {
    checkAdmin(req);
    const body = readJson(req);
    const persona = PERSONAS[Number(body.persona)];
    if (!persona) throw new HttpError(400, 'Unknown test persona.');

    const db = dbClient();
    if (body.deleteId !== undefined) {
      const deleteId = typeof body.deleteId === 'string' ? body.deleteId.trim() : '';
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deleteId)) {
        throw new HttpError(400, 'Invalid test submission id.');
      }
      const { data, error } = await db
        .from('submissions')
        .delete()
        .eq('id', deleteId)
        .is('participant_id', null)
        .eq('is_test', true)
        .eq('uid', persona.uid)
        .select('id');
      if (error) throw new HttpError(500, 'Could not delete the test persona submission.');
      return send(res, 200, { deleted: data?.length === 1 });
    }

    const content = typeof body.content === 'string' ? body.content.trim() : '';
    const summary = typeof body.summary === 'string' ? body.summary.trim() : '';
    const pillars = Array.isArray(body.pillars)
      ? [...new Set(body.pillars.filter((n) => Number.isInteger(n) && n >= 1 && n <= 12))].sort((a, b) => a - b)
      : [];
    if (!content || content.length > 100000) throw new HttpError(400, 'Test contribution must be 1 to 100,000 characters.');
    if (summary.length > 2000) throw new HttpError(400, 'Summary is too long.');

    const { error } = await db.from('submissions').insert({
      pillars,
      content,
      summary,
      auto_tagged: body.autoTagged === true,
      is_test: true,
      participant_id: null,
      uid: persona.uid,
      display_name: persona.name,
    });
    if (error) throw new HttpError(500, 'Could not save the test persona submission.');
    return send(res, 200, { saved: true });
  } catch (err) {
    return fail(res, err);
  }
}
