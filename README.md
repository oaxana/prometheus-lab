# Prometheus Lab

Anonymous submissions for the Burning Man AI Constitution. Claude summarizes each one and tags it to the 12 pillars; the project lead can run an AI synthesis (commons / contested ground / gaps).

- **Frontend:** plain HTML/CSS/JS in `public/`
- **Database:** Supabase (Postgres)
- **AI:** two Vercel serverless functions in `api/` that call Claude (`claude-sonnet-5-5`), so the API key never reaches the browser
- **Hosting:** Vercel

## Setup

### 1. Supabase
1. Create a project at [supabase.com](https://supabase.com).
2. **SQL Editor → New query**, paste all of `supabase-setup.sql`, **Run**.
3. **Project Settings → API**: copy the **Project URL**, the **anon** key, and the **service_role** key.
4. Put the URL and anon key in `public/config.js`. (The anon key is meant to be public. Never put the service_role key in this file.)

### 2. Anthropic
Create an API key at [console.anthropic.com](https://console.anthropic.com).

### 3. Deploy to Vercel
1. Push this repo to GitHub.
2. In Vercel: **Add New → Project**, import the repo. No build settings needed (`vercel.json` handles it).
3. Before deploying, add these **Environment Variables** (see `.env.example`):

   | Name | Value |
   |---|---|
   | `ANTHROPIC_API_KEY` | your Anthropic key |
   | `SUPABASE_URL` | your Supabase Project URL |
   | `SUPABASE_SERVICE_ROLE_KEY` | the service_role key (server-only) |
   | `ADMIN_KEY` | a passphrase you choose; unlocks "Run synthesis" |
   | `SITE_PASSWORD` | the crew password shown on the landing page (use a different one from `ADMIN_KEY`) |

4. Deploy, then share the URL.

### 4. Running synthesis
Open the **Synthesis** tab → **Project lead? Unlock** → enter your `ADMIN_KEY` → **Run synthesis**. Results are saved and visible to everyone.

## Crew password
`middleware.js` puts a password page in front of the whole site, including `config.js` and `/api/*`. Share `SITE_PASSWORD` with the crew only. A correct entry sets a 30-day cookie. To rotate the password or kick everyone out, change `SITE_PASSWORD` in Vercel and redeploy. If the variable is missing, the site stays locked. Add a rate-limit rule on `/__login` in Vercel → Firewall to slow brute-force guessing.

## Local development
```bash
npm install
cp .env.example .env      # fill in the values
npx vercel dev            # serves public/, api/ and the password gate at http://localhost:3000
```

## Supported submission formats
Text, `.txt`/`.md`, `.docx`, `.pptx` (slide text in deck order plus speaker notes), `.pdf`, images, and **Google Docs / Google Slides links**. Google files must be shared as "Anyone with the link can view"; the `api/google-doc.js` function fetches Google's plain-text export and only ever contacts Google. Images inside slides are not read, and old `.ppt` / Keynote files must be saved as `.pptx` first.

## How privacy works
- Each browser gets a random anonymous ID in `localStorage`. "Mine only" and "yours" use it. Clearing site data loses that link to your past submissions.
- Raw text is never readable with the public key. The browser reads through the `list_submissions` database function, which returns everyone's summaries but only returns raw text for rows matching *your* ID. Only the `synthesize` function (service-role key) reads all raw text.

## Notes
- Voices refresh from Supabase every 20 seconds (and when you return to the tab) rather than live-streaming.
- `api/_shared.js` and `public/pillars.js` both list the pillar names; edit both if you rename a pillar.
- `/api/summarize` is public (participants need it). To limit abuse, add a rate-limit rule in Vercel → Firewall.
