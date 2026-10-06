// Shared helpers for the serverless functions.
// Files starting with "_" in api/ are NOT exposed as routes by Vercel.
import Anthropic from '@anthropic-ai/sdk';

export const MODEL = 'claude-sonnet-5-5';

// Server-side copy of the pillar names (ids + names only). Keep in sync with public/pillars.js.
export const PILLARS = [
  { id: 1, name: 'Consent, Privacy & Data Sovereignty' },
  { id: 2, name: 'Human Agency & Autonomy' },
  { id: 3, name: 'Access, Equity & Inclusion' },
  { id: 4, name: 'Safety, Care & Wellbeing' },
  { id: 5, name: 'Art, Creativity & Self-Expression' },
  { id: 6, name: 'Environmental Stewardship' },
  { id: 7, name: 'Gifting, Anti-Commodification & Open Source' },
  { id: 8, name: 'Community Governance & Power' },
  { id: 9, name: 'Education & AI Literacy' },
  { id: 10, name: 'AI Presence, Identity & Immediacy' },
  { id: 11, name: 'The Default World Bridge' },
  { id: 12, name: 'Hard Constraints & Bright Lines' },
];

export const PILLAR_LIST = PILLARS.map((p) => `${p.id}. ${p.name}`).join('\n');
export const pillarName = (id) => PILLARS.find((p) => p.id === id)?.name;

let _client;
export function anthropic() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new HttpError(500, 'ANTHROPIC_API_KEY is not set on the server.');
  }
  return (_client ??= new Anthropic());
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function send(res, status, body) {
  res.status(status).setHeader('Cache-Control', 'no-store').json(body);
}

export function readJson(req) {
  const b = req.body;
  if (b && typeof b === 'object') return b;
  if (typeof b === 'string' && b) {
    try {
      return JSON.parse(b);
    } catch {
      throw new HttpError(400, 'Request body is not valid JSON.');
    }
  }
  return {};
}

// Pull the JSON object out of a Messages API response made with output_config.format.
export function parseJsonResponse(msg) {
  if (msg.stop_reason === 'refusal') {
    throw new HttpError(422, 'The model declined to process this content.');
  }
  if (msg.stop_reason === 'max_tokens') {
    throw new HttpError(502, 'The model response was cut off. Try again with less content.');
  }
  const text = msg.content.find((b) => b.type === 'text')?.text;
  if (!text) throw new HttpError(502, 'The model returned no text.');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(502, 'The model returned malformed JSON.');
  }
}

// Turn any thrown error into a JSON response. Never leaks keys or stack traces.
export function fail(res, err) {
  if (err instanceof HttpError) return send(res, err.status, { error: err.message });
  if (err instanceof Anthropic.AuthenticationError) {
    return send(res, 500, { error: 'Server Anthropic API key is invalid.' });
  }
  if (err instanceof Anthropic.RateLimitError) {
    return send(res, 429, { error: 'The AI is busy right now. Please try again in a moment.' });
  }
  if (err instanceof Anthropic.APIError) {
    console.error('Anthropic API error', err.status, err.message);
    return send(res, 502, { error: 'The AI service returned an error.' });
  }
  console.error(err);
  return send(res, 500, { error: 'Unexpected server error.' });
}
