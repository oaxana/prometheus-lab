// GET  /api/admin                                  -> { admin: boolean }   (is this browser logged in as admin?)
// POST /api/admin  { action: 'login', password }   -> { admin: true } + HttpOnly session cookie, or 401
// POST /api/admin  { action: 'logout' }            -> { admin: false } + clears the cookie
// The password is checked here against ADMIN_PASSWORD, never in the browser. The cookie has no Max-Age,
// so it lasts until the browser is closed (or "Log out of admin").
import { ADMIN_COOKIE, adminToken, safeEqual, isAdmin, HttpError, send, readJson, fail } from './_shared.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cookie(req, value, clear = false) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `${ADMIN_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict${secure}${clear ? '; Max-Age=0' : ''}`;
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') return send(res, 200, { admin: isAdmin(req) });
    if (req.method !== 'POST') return send(res, 405, { error: 'Use GET or POST.' });

    const body = readJson(req);
    if (body.action === 'logout') {
      res.setHeader('Set-Cookie', cookie(req, '', true));
      return send(res, 200, { admin: false });
    }
    if (body.action !== 'login') throw new HttpError(400, 'Unknown action.');

    const password = process.env.ADMIN_PASSWORD;
    if (!password) throw new HttpError(503, 'ADMIN_PASSWORD is not configured on the server.');
    const given = typeof body.password === 'string' ? body.password : '';
    if (!given || !safeEqual(given, password)) {
      await sleep(1000); // slows down guessing
      throw new HttpError(401, 'That password isn’t right.');
    }
    res.setHeader('Set-Cookie', cookie(req, adminToken(password)));
    return send(res, 200, { admin: true });
  } catch (err) {
    return fail(res, err);
  }
}
