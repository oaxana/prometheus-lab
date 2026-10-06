// POST /api/google-doc
// Body:    { url }   a Google Docs or Google Slides link
// Returns: { name, kind: 'document' | 'presentation', text }
//
// Fetches Google's plain-text export of a file that is shared as "Anyone with the link can view".
// It has to run on the server because browsers can't read Google's export directly (CORS).
// Only docs.google.com / *.googleusercontent.com are ever contacted, so this can't be used to reach anything else.
import { HttpError, send, readJson, fail } from './_shared.js';

const MAX_BYTES = 1_000_000;
const MAX_HOPS = 5;
const NOT_SHARED = 'Google would not let us read that file. Set sharing to "Anyone with the link can view" and try again.';

// Strictly anchored: https only, exactly docs.google.com, and a plausible file id.
const LINK = /^https:\/\/docs\.google\.com\/(?:a\/[A-Za-z0-9.-]+\/)?(document|presentation)\/d\/([A-Za-z0-9_-]{20,})(?:[/?#]|$)/;

const EXPORT = {
  document: (id) => `https://docs.google.com/document/d/${id}/export?format=txt`,
  presentation: (id) => `https://docs.google.com/presentation/d/${id}/export/txt`,
};

const hostAllowed = (host) => host === 'docs.google.com' || host.endsWith('.googleusercontent.com');

function titleFrom(res, fallback) {
  const cd = res.headers.get('content-disposition') ?? '';
  let name = '';
  const star = cd.match(/filename\*=UTF-8''([^;]+)/i);
  if (star) {
    try {
      name = decodeURIComponent(star[1]);
    } catch {}
  }
  if (!name) name = cd.match(/filename="([^"]+)"/i)?.[1] ?? '';
  name = name.replace(/\.txt$/i, '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 120);
  return name || fallback;
}

async function readCapped(res) {
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_BYTES) {
      await reader.cancel();
      throw new HttpError(413, 'That document is too large (limit about 1 MB of text). Try pasting the key parts instead.');
    }
    chunks.push(value);
  }
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks)).replace(/^﻿/, '');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST.' });
  try {
    const link = String(readJson(req).url ?? '').trim();
    const m = link.match(LINK);
    if (!m) throw new HttpError(400, 'That doesn\'t look like a Google Docs or Google Slides link.');
    const [, kind, id] = m;

    let target = EXPORT[kind](id);
    for (let hop = 0; ; hop++) {
      if (hop > MAX_HOPS) throw new HttpError(502, 'Google redirected too many times.');
      let r;
      try {
        r = await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
      } catch {
        throw new HttpError(502, 'Could not reach Google. Try again in a moment.');
      }

      if ([301, 302, 303, 307, 308].includes(r.status)) {
        let next;
        try {
          next = new URL(r.headers.get('location') ?? '', target);
        } catch {
          throw new HttpError(403, NOT_SHARED);
        }
        // A redirect to a sign-in page (or anywhere unexpected) means the file isn't public.
        if (next.protocol !== 'https:' || !hostAllowed(next.hostname)) throw new HttpError(403, NOT_SHARED);
        target = next.toString();
        continue;
      }
      if (r.status === 404 || r.status === 410) throw new HttpError(404, 'We couldn\'t find that file. Check the link.');
      if (r.status === 401 || r.status === 403) throw new HttpError(403, NOT_SHARED);
      if (!r.ok) throw new HttpError(502, 'Google returned an error. Try again in a moment.');
      if (!(r.headers.get('content-type') ?? '').toLowerCase().startsWith('text/plain')) throw new HttpError(403, NOT_SHARED);

      const text = (await readCapped(r)).trim();
      if (!text) throw new HttpError(422, 'That file looks empty.');
      const name = titleFrom(r, kind === 'presentation' ? 'Google Slides' : 'Google Doc');
      return send(res, 200, { name, kind, text });
    }
  } catch (err) {
    return fail(res, err);
  }
}
