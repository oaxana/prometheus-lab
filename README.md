# Prometheus Lab

A private web app where a crew can contribute anonymous (or named) positions on how humans and AI should behave together, for the **Burning Man AI Constitution** project. Claude summarizes each submission and tags it to 12 constitutional pillars. The project lead can then run an AI **synthesis** that sorts everything into **The Commons** (where voices agree), **Contested Ground** (where they diverge, and who holds which position) and **The Gaps** (pillars nobody addressed).

- **Live site:** https://prometheus-lab-xi.vercel.app (password-protected, crew only)
- **Status:** deployed and working. See [Project status](#project-status--where-we-left-off) for what is verified, what isn't, and the open to-do list.
- **Name history:** originally "The Fire Circle", renamed Prometheus Lab. Only the files in `docs/` still use the old name, on purpose.

---

## Contents
1. [Features](#features)
2. [How it works](#how-it-works)
3. [Repository map](#repository-map)
4. [Setup from scratch](#setup-from-scratch)
5. [Using the app](#using-the-app)
6. [Security and privacy model](#security-and-privacy-model)
7. [Database reference](#database-reference)
8. [API reference](#api-reference)
9. [Testing](#testing)
10. [Project status / where we left off](#project-status--where-we-left-off)
11. [Decisions & deviations](#decisions--deviations)
12. [Known limitations](#known-limitations)
13. [Troubleshooting](#troubleshooting)
14. [Conventions for contributors](#conventions-for-contributors)
15. [History](#history)

---

## Features

**For everyone on the crew**
- **Password gate** on the landing page; nothing is reachable without it.
- **Five tabs:** Home, Pillars, Submit, Voices, Synthesis.
- **Pillars:** the 12 constitutional pillars with expandable sub-topics.
- **Submit** by typing/pasting text, or by adding files: `.txt`, `.md`, `.docx`, `.pptx` (slide text in deck order plus speaker notes), `.pdf` (scanned PDFs are read by Claude), images (`.png`/`.jpg`, read by Claude vision), or a **Google Docs / Google Slides link** (file must be shared "Anyone with the link can view").
- **Pillars optional:** pick 1–3, or skip and Claude auto-tags them.
- **Anonymous by default**; optionally add a name or handle.
- **Voices:** a per-pillar coverage chart plus a card per submission showing the AI *summary*, tags and date. Your own cards (matched by a private per-browser ID) show a "yours" badge and let you expand the full text, **mark/unmark as test**, or **delete**. Filters: "Show tests", "Mine only".
- **Synthesis:** the latest saved result is visible to everyone.

**For the project lead** (after unlocking with `ADMIN_KEY` on the Synthesis tab)
- **Run synthesis**, optionally including test submissions.
- **Testing personas** on the Submit tab ("Testing as: Off / Me / Persona 2 / Persona 3") to play several people from one browser.
- Results attribute each view to named authors; anonymous submitters are shown only as a count ("3 anonymous").

## How it works

```
 Browser (public/, plain HTML/CSS/JS)
   │
   ├── every request ──► middleware.js ── crew password gate (cookie)  [Vercel Routing Middleware]
   │
   ├── reads/writes ───► Supabase (Postgres)  via the public anon key + row-level security + 3 RPC functions
   │
   └── /api/* ─────────► Vercel serverless functions (Node)
          ├─ summarize.js   → Claude (summary + pillar tags, one call per submission)
          ├─ synthesize.js  → reads ALL submissions from Supabase (service-role key) → Claude → stores result
          └─ google-doc.js  → fetches Google's plain-text export of a shared Doc/Slides link
```

- **Frontend:** no framework and no build step. `public/app.js` renders everything with template strings; file parsing happens in the browser (`mammoth` for .docx, `pdf.js` for .pdf, `JSZip` for .pptx).
- **AI:** both Claude calls use **`claude-sonnet-5-5`** (one constant, `MODEL` in `api/_shared.js`). Summaries run at `low` effort, synthesis at `medium`. Both use structured JSON output, so the reply is always valid JSON.
- **Live updates:** the page re-fetches every 20 seconds and when you return to the tab (no websockets).

## Repository map

```
public/                  static site (this folder is what Vercel serves)
  index.html             page shell; loads CDN libraries
  app.js                 the whole UI: render functions, file parsing, Supabase + API calls
  styles.css             design tokens + styles (dark primary, fire-amber accent, light via prefers-color-scheme)
  pillars.js             the 12 pillars (names, emoji, sub-topics)
  config.js              Supabase URL + anon key (public by design)
api/                     Vercel serverless functions
  _shared.js             model name, pillar names, Claude client, error handling ("_" = not a route)
  summarize.js           POST: text/images/PDFs → { pillars, summary, autoTagged }
  synthesize.js          POST (admin key): builds + stores the commons/contested/gaps synthesis
  google-doc.js          POST: Google Docs/Slides link → { name, kind, text }
middleware.js            crew password gate in front of everything (pages, config.js, /api/*)
supabase-setup.sql       tables, security policies, RPC functions. Idempotent: safe to re-run
seed-test-voices.sql     12 fake voices from "Me / Persona 2 / Persona 3" for testing synthesis
vercel.json              static output dir, function timeouts, security headers
package.json             runtime deps: @anthropic-ai/sdk, @supabase/supabase-js, @vercel/functions
.env.example             every environment variable, documented
tests/                   self-contained test suites (own package.json, never installed by Vercel)
docs/                    original handoff spec + the original prototype (historical reference)
CLAUDE.md                context file for AI assistants working in this repo
```

## Setup from scratch

You need free accounts at GitHub, Supabase, Anthropic (API billing) and Vercel, plus Node.js ≥ 20.

### 1. Supabase
1. Create a project.
2. **SQL Editor → New query**, paste all of `supabase-setup.sql`, **Run**. Check **Table Editor** shows `submissions` and `synthesis`.
3. **Project Settings → API**: copy the **Project URL**, the **anon** key and the **service_role** key.
4. Put the Project URL and anon key in `public/config.js`. The anon key is public by design; **never** put the service_role key there.

### 2. Anthropic
Create an API key at console.anthropic.com. **Set a monthly spend limit** there.

### 3. Vercel
1. Import the GitHub repo. Settings: **Application Preset: Other**, Root Directory `./`, Build Command empty, Output Directory `public` (`vercel.json` already sets these), Install Command default.
2. Add these **Environment Variables** (all environments) *before* the first deploy:

   | Variable | What it is |
   |---|---|
   | `ANTHROPIC_API_KEY` | Anthropic key (server-only) |
   | `SUPABASE_URL` | Supabase Project URL, same as in `config.js` |
   | `SUPABASE_SERVICE_ROLE_KEY` | Supabase **service_role** key. Server-only; bypasses row-level security |
   | `ADMIN_KEY` | Passphrase you invent; unlocks "Run synthesis" and the testing personas |
   | `SITE_PASSWORD` | The crew password shown on the landing page (use a different value from `ADMIN_KEY`) |

   Changing a variable later requires a **Redeploy** (Deployments → ⋯ → Redeploy). If `SITE_PASSWORD` is missing, the whole site shows "This site isn't set up yet" (it fails closed).
3. Deploy. Every push to `main` redeploys automatically.
4. Recommended: **Firewall → Configure → + New Rule** → If *Request Path equals* `/__login` → Then *Rate Limit*, Fixed Window, 60 s, limit 10, key IP → Save → **Review Changes → Publish** (Hobby plan allows one rate-limit rule).

### Local development
```bash
npm install
cp .env.example .env        # fill in the values
npx vercel dev              # serves public/, api/ and the password gate at http://localhost:3000
```

## Using the app

**Crew:** open the site → enter the crew password → Submit.

**Project lead, running a synthesis:**
1. Synthesis tab → **Project lead? Unlock** → enter `ADMIN_KEY` (kept for that browser tab only).
2. Optionally switch on **Include test submissions**.
3. **Run synthesis** (about 20–60 s; costs a few cents).

**Testing without real people** (three ways):
1. **Type different names:** on Submit turn **Anonymous** off, give a different name each time, tick **Test submission** each time (it resets after every submit). Names must match exactly to count as the same person.
2. **Personas:** after unlocking, Submit shows **Testing as: Off · Me · Persona 2 · Persona 3**. Each persona has its own anonymous ID, auto-fills its name, and (for 2 and 3) is marked as test.
3. **Seed data:** paste `seed-test-voices.sql` into the Supabase SQL Editor for 12 ready-made voices designed to produce contested ground on pillars 1, 4 and 7, commons on 5/10/12, and gaps on 2/3/6/8/9/11. Remove them with:
   ```sql
   delete from public.submissions where uid like 'demo-voter-%';
   ```

**Keeping test data out of real results:** anything flagged *test* is excluded from synthesis and from the public counts unless "Include test submissions" is on. "Mark as test" is reversible; "Delete" is not. A previously saved synthesis is not updated until you run it again.

## Security and privacy model

| Asset | Protected by |
|---|---|
| The whole site, `config.js`, `/api/*` | `middleware.js`: crew password → 30-day `HttpOnly`, `Secure`, `SameSite=Lax` cookie holding a keyed hash (not the password). Changing `SITE_PASSWORD` logs everyone out. Failed attempts are delayed 1 s. Fails closed if the variable is unset. |
| Raw submission text and owner IDs | `submissions` has row-level security with **no read policy**. Browsers read only via `list_submissions()`, which returns everyone's summaries but raw text **only for rows matching the caller's own anonymous ID**. Owner IDs are never returned. |
| Deleting / re-flagging submissions | Only via `delete_my_submission()` and `set_my_submission_test()`, which require both the row id and the owner's ID. |
| Synthesis table | Readable by anyone with the anon key, writable only by the service-role key (server). |
| Running synthesis | `x-admin-key` header checked server-side with a constant-time comparison. |
| Claude API key, service-role key | Server environment variables only; never in the browser or repo. |
| Google link fetching | Strict URL pattern; only `docs.google.com` and `*.googleusercontent.com` are ever contacted; redirects re-checked on every hop; 1 MB cap. |
| Prompt injection | User text is wrapped in tags and the model is told to treat it as data; AI output is validated (pillar ids, author names) and HTML-escaped before display. |

**Honest caveats**
- "Anonymous" means no name is shown; ownership is tracked by a random ID in the browser. Clearing site data loses the link to your past submissions.
- One shared crew password: you cannot remove a single person, only rotate it.
- **Named** authors appear by name in the synthesis everyone can read. Anonymous submitters appear only as "N anonymous". A privacy review of this is on the to-do list.
- **The Supabase URL and anon key are in this repository, and the anon key is public by design.** Row-level security keeps *raw text* private regardless. But anyone holding that key (so, anyone, if the repo is public) can call Supabase's API directly, which **bypasses the password gate** (the gate protects the website and the AI endpoints, not Supabase itself). With the key they can read the *summaries, names, pillar tags and saved synthesis* via `list_submissions()` and the `synthesis` table, and insert rows. Mitigations: keep the repository **private**, and/or move all reads and writes behind the gated `/api` (see to-do #1). A full-history scan on 2026-10-05 found no other secret in git.

## Database reference

**Tables** (see `supabase-setup.sql` for exact definitions)
- `submissions`: `id`, `pillars int[]` (1–12), `content` (≤100,000 chars, private), `summary`, `auto_tagged`, `is_test`, `uid` (owner, private), `display_name`, `created_at`.
- `synthesis`: single row (`id = 1`): `commons`, `contested`, `gaps` (jsonb), `count`, `included_tests`, `created_at`.

**Functions** (the only way browsers touch `submissions`, all `security definer`)
- `list_submissions(p_uid)`: all rows, with `mine` and `content` filled only for the caller's own rows.
- `delete_my_submission(p_id, p_uid)` → boolean.
- `set_my_submission_test(p_id, p_uid, p_is_test)` → boolean.

**Stored synthesis shape**
```jsonc
{ "commons":   [{ "pillar", "pillarId", "strength": "strong|moderate|emerging",
                  "points": [{ "point", "voices": ["Mary", "2 anonymous"] }] }],
  "contested": [{ "pillar", "pillarId", "tension",
                  "positions": [{ "stance", "voices": ["Mary"] }] }],
  "gaps":      [{ "pillar", "pillarId", "note" }] }
```
Older saved results (plain-string positions, single `summary` per commons item) still display.

## API reference

All three require the crew cookie (otherwise `401 {code:"crew_login"}`).

| Endpoint | Body | Returns |
|---|---|---|
| `POST /api/summarize` | `{ text, selectedPillars?, attachments?: [{name, mediaType, data(base64)}] }` | `{ pillars, summary, autoTagged, attachmentsSkipped? }`. Text capped at 8,000 chars; ≤4 attachments, 3 MB total; images/PDFs only |
| `POST /api/synthesize` | `{ includeTests? }` + header `x-admin-key` | The synthesis (also stored). Reads up to 1,000 submissions, 6,000 chars each |
| `POST /api/google-doc` | `{ url }` | `{ name, kind, text }`. Public Docs/Slides only |

## Testing

All suites live in `tests/` and need **no real Anthropic, Supabase or Google access**: `tests/harness.mjs` serves the real `public/` files and the real `api/` + `middleware.js` code against fake Anthropic/Supabase/Google servers; the SQL suites run `supabase-setup.sql` in an in-memory Postgres (PGlite).

```bash
npm install                 # once, in the repo root (the tests import the API code)
cd tests && npm install     # once; uses your installed Google Chrome (or: npx playwright install chromium, PW_CHANNEL=chromium)
npm test                    # all 10 suites, ~2 min   (npm test -- persona  runs one)
```

| Suite | Covers |
|---|---|
| `gate.test.mjs` (28) | password gate: fail-closed, cookies, tampering, rotation, API 401s |
| `google-doc.test.mjs` (16) | Google link endpoint: redirects, private docs, hostile URLs, size limits |
| `sql-delete` / `sql-mark-test` / `sql-seed` (12/12/7) | the real SQL: ownership rules, RLS, seed data |
| `app.e2e.mjs` (33) | main flow in a real browser: submit, privacy between users, filters, synthesis, light/dark |
| `delete.e2e` / `mark-test.e2e` (10/10) | delete and mark-as-test buttons |
| `persona.e2e.mjs` (36) | personas, attribution, bullet layouts, anonymous counts, legacy data |
| `files.e2e.mjs` (22) | .pptx (order, notes), Google links, what the AI actually receives |

**What the tests do NOT prove:** the fakes return canned model replies, so they cannot tell you whether the *real* Claude produces good synthesis output. That needs a manual run (see status below).

## Project status / where we left off

*Last updated: 2026-10-05.*

**Done and deployed:** everything in [Features](#features); the latest feature commit is on `main` and live. All 10 local suites pass.

**Verified against the real services:** site is up and gated; `/api/summarize` returns real summaries and tags; admin lock works; Supabase security rules behave as designed (checked with the public key); the Google Slides export URL pattern works on a real public deck; the delete and mark-as-test SQL functions exist in the live database.

**Not yet verified (please check)**
- [ ] The **new synthesis prompts/layout with the real model** (attribution, bulleted Commons/Contested/Gaps, "N anonymous"). Run synthesis on the seed data and review the output.
- [ ] A real **Google Doc** link end to end (Slides is confirmed; Docs uses the same mechanism but wasn't tried on a live doc).
- [ ] A real **.pptx** and **.docx** upload in the live app.
- [ ] The raw-text privacy check with real rows (the table was empty when checked): a direct read of `submissions` with the anon key should return `[]` even when rows exist.

**Open to-do list (roughly in priority order)**
1. **Privacy review** (explicitly deferred by the owner), starting with **who can reach the data**: the repo was found to be public on 2026-10-05, which exposes the anon key, so summaries/names/synthesis are readable by outsiders and rows can be inserted directly (see Security caveats). Options, simplest first: (a) make the GitHub repo private (Settings → Danger Zone → Change visibility; Vercel keeps working), (b) move reads/writes behind the gated API so the anon key has no access at all (then the key is harmless even if public), (c) rotate the Supabase keys. Then the remaining questions: named attribution in the public synthesis, what anonymous means in practice, retention, an attribution on/off switch.
2. **Confirm the guardrails are set:** Anthropic monthly spend limit; Vercel Firewall rate-limit rule on `/__login`.
3. **Decide on the AI text limits** (8,000 chars per submission for summaries, 6,000 per submission for synthesis). Long decks/docs are cut off for the AI though the full text is stored. The model's context is far larger, so these can be raised.
4. **Clean up test data** before sharing widely (`delete from public.submissions where uid like 'demo-voter-%';` plus any manual test rows). At the end of the 2026-10-05 session the database held 10 submissions and a saved synthesis from testing.
5. Share `SITE_PASSWORD` with the crew only.

**Ideas / backlog:** "Clear saved synthesis" button; option to use a different model for summaries vs synthesis; server-side refusal fallbacks (see decisions); `X-Frame-Options`/CSP hardening; per-person access instead of one shared password; export of synthesis; raising the 4-attachment cap or telling users about it.

## Decisions & deviations

Why things are the way they are (including where we departed from the original spec in [`docs/original-handoff-spec.md`](docs/original-handoff-spec.md)):

- **Plain HTML/JS, Supabase, Vercel functions, no login.** As specified. Identity is a random per-browser ID.
- **A real server-side password gate**, not a script in the page. A client-side check would be cosmetic: anyone could read `config.js` or call `/api/*` directly. Middleware runs in front of everything, so it also protects the AI credits.
- **Raw text is private via database functions, not just UI hiding.** With the public key, a readable table would expose everyone's raw text. So there is no read policy; browsers go through functions.
- **Extra env vars beyond the original "three":** `ADMIN_KEY` (stops strangers spending Anthropic credits via `/api/synthesize`) and `SITE_PASSWORD` (the landing-page gate). Five total.
- **Model:** `claude-sonnet-5-5` for both calls (the spec said Sonnet 4.6/Haiku; the owner asked for Sonnet 5.5). Structured JSON output instead of parsing free text. `effort` low for summaries, medium for synthesis. **Server-side refusal fallbacks were deliberately not enabled**: they only cover cyber/competing-AI refusals, which are unlikely for this content, and rely on a beta we couldn't test. A refusal returns a clear error and the submission still saves with a plain summary.
- **Polling every 20 s instead of realtime**, because browsers can't subscribe to a table they're not allowed to read.
- **Bugs in the original prototype that were fixed:** the AI step never ran (`imgBlobs` used before definition); typed text vanished on re-render; synthesis output was injected as raw HTML (now escaped).
- **Anonymous voices are counted per submission** ("3 anonymous"), never numbered or linked, and anonymous IDs are not sent to the model.
- **"Mark as test" instead of only "Delete"**: reversible, which suits heavy testing.
- **Google links are fetched server-side** (browsers are blocked by CORS) with strict host allow-listing.
- **Tests live in `tests/` with their own `package.json`**, so Vercel never installs Playwright/PGlite.
- **Pillar names exist in two places** (`public/pillars.js` and `api/_shared.js`); keep them in sync.

## Known limitations

- Voices update every ~20 s, not instantly.
- "Yours" is per browser: other devices or cleared storage can't manage past submissions (use Supabase's Table Editor).
- Deleting or re-flagging a voice doesn't change an already-saved synthesis until it is re-run.
- Images inside slides/docs aren't read (only text). Legacy `.ppt`/Keynote must be saved as `.pptx`.
- More than 4 image/PDF attachments in one submission makes the AI step fall back to a plain 200-character summary.
- Synthesis reads at most 1,000 submissions and has a 60 s function limit; a very large run could time out on Vercel's free plan.
- Supabase's free tier can pause an inactive project; unpause it in the dashboard.
- The crew password is shared; rotation is the only revocation.

## Troubleshooting

| You see | Likely cause / fix |
|---|---|
| "This site isn't set up yet" | `SITE_PASSWORD` missing in Vercel → add it, redeploy |
| Correct password just reloads the box | Trailing space in the Vercel value; re-copy it |
| "Could not load voices" toast | `public/config.js` wrong (URL must be `https://<ref>.supabase.co`), SQL not run, or Supabase project paused |
| Summary is just the first 200 characters | The AI step failed: check `ANTHROPIC_API_KEY`, Anthropic billing, Vercel function logs |
| "Wrong admin key" | `ADMIN_KEY` mismatch (the unlock is per tab; reopening needs re-entry) |
| Delete / Mark-as-test shows an error | The newest SQL wasn't run: re-run `supabase-setup.sql` (safe) |
| "Google would not let us read that file" | Share the file as "Anyone with the link can view" |
| Synthesis result looks old | Re-run it; saved results keep their original shape and content |
| Changes not visible after deploy | Hard refresh (Cmd+Shift+R); check Vercel → Deployments is "Ready" |

## Conventions for contributors

- **Never commit secrets.** `.env` is git-ignored; the Anthropic key and service-role key live only in Vercel/your `.env`. The anon key in `config.js` is the only key in the repo, by design.
- **Database changes** go into `supabase-setup.sql` as idempotent statements (`create or replace`, `if not exists`) and must be **run in Supabase before** deploying frontend code that depends on them.
- **Run `cd tests && npm test` before pushing.** Add or extend a suite with every behavior change.
- **Commit messages:** short imperative summary of the change. Commit and push only when the owner asks.
- Keep the design tokens in `public/styles.css`; dark mode is primary and light mode follows `prefers-color-scheme`.

## History

| Commit | Change |
|---|---|
| `dc4ade5` | Initial commit |
| `d628b10` | Static frontend, Vercel API functions, Supabase schema |
| `f663c30` | Crew password gate (routing middleware) |
| `c281e15` | Delete own submissions; mark/unmark as test |
| `93a28ed` | Per-author attribution in synthesis, bulleted Contested Ground, testing personas, seed data |
| `3cf7c3f` | Bulleted Commons and Gaps layouts |
| `6001b37` | Anonymous voices shown as a count; anonymous IDs no longer sent to the model |
| `cb62135` | `.pptx` upload and Google Docs/Slides links |
| *(this commit)* | Tests moved into the repo, docs archived, README and `CLAUDE.md` written |
