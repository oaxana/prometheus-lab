> **Historical document.** This is the original build spec, written when the project was still called "The Fire Circle" (it was later renamed **Prometheus Lab**). It describes the *starting point*; the shipped app differs in several ways (see the root README, "Decisions & deviations"). The prototype it refers to is [`prototype.html`](prototype.html), kept as a frozen reference for the design.

# Fire Circle — Production Build Handoff

## What this is
I'm building "The Fire Circle," a web app for the Burning Man AI Constitution project. It collects anonymous submissions from ~20-100 participants, auto-tags them to constitutional pillars using Claude, and runs AI synthesis to find consensus, disagreement, and gaps. I have a working prototype built as a Claude artifact (attached as `fire-circle.html`). I need to rebuild it as a real standalone app I can host and share.

## What the app does (features from the prototype)

### 5 tabs: Home, Pillars, Submit, Voices, Synthesis

**Home** — Landing page with submission count, pillar coverage count, and the user's own submission count. CTAs to submit or view pillars.

**Pillars** — Reference tab showing all 12 constitutional pillars with expandable sub-bullets. Each pillar has a name, emoji, optional Burning Man principle connection, and a list of sub-questions/topics.

**Submit** — The input form:
- Drag-and-drop file upload (.txt, .docx, .pdf, .png, .jpg) OR paste/type text
- .docx parsed with mammoth.js, PDF parsed with pdf.js, images sent to Claude Vision API for OCR/analysis
- Optional pillar selection (grid of 12 toggleable chips) — if skipped, Claude auto-detects which pillars the submission touches
- Anonymous by default, optional name field
- "Test submission" toggle — tests are excluded from synthesis by default
- On submit: Claude generates a 1-2 sentence summary + auto-tags pillars (one API call)
- Summary is what other people see; raw text is private to the submitter

**Voices** — Dashboard:
- Bar chart showing submission count per pillar (pillar coverage heatmap)
- Filter toggles: "Show tests" and "Mine only"
- Submission cards showing: summary (not raw text), pillar tags, date, auto-tagged badge, "yours" badge for own submissions
- Own submissions have a "Show your full submission" expander to see raw text

**Synthesis** — AI analysis (owner/admin only can trigger):
- "Include test submissions" toggle
- "Run synthesis" button that sends all submissions to Claude
- Output in three sections:
  - **The Commons** — where voices agree (pillar, summary, strength: strong/moderate/emerging)
  - **Contested Ground** — where voices diverge (pillar, positions[], core tension)
  - **The Gaps** — pillars nobody addressed (pillar, why it matters)
- Results are stored and visible to all participants
- Before any synthesis runs, preview blocks explain what each section will show

## The 12 Pillars (data to embed in the app)

```json
[
  {"id":1,"name":"Consent, Privacy & Data Sovereignty","emoji":"🔒","principle":"Participation","bullets":["When AI is present, people must know — disclosure is non-negotiable","Opt-in vs. opt-out: what should the default be?","Right to know if you're interacting with AI vs. a human","Consent for being recorded, analyzed, or tracked","What informed consent means when AI is complex","Withdrawal of consent at any time, with real effect","What data can AI collect on playa, and what is off-limits","Who owns data generated at Burning Man","Data retention limits and mandatory deletion after the event","Facial recognition and biometric data: where is the line?","Right to access, correct, and delete your data","Data that stays on playa vs. data that leaves"]},
  {"id":2,"name":"Human Agency & Autonomy","emoji":"🧭","principle":"Radical Self-Reliance","bullets":["AI augments human capability — never replaces human choice","Right to disconnect from AI entirely, at any time","Designated AI-free zones and analog spaces","No AI-driven manipulation, persuasion, or dark patterns","Cognitive liberty: freedom from AI-mediated influence","When AI should advise, decide, or stay silent","Preventing dependency on AI tools"]},
  {"id":3,"name":"Access, Equity & Inclusion","emoji":"🌍","principle":"Radical Inclusion","bullets":["AI tools available regardless of wealth, status, or skill","Language accessibility and real-time translation","Disability accessibility in AI interactions","Bridging the digital divide on playa","No AI-created class system — tech haves vs. have-nots","Ensuring AI doesn't amplify existing inequities"]},
  {"id":4,"name":"Safety, Care & Wellbeing","emoji":"❤️","principle":null,"bullets":["AI for Rangers: situational awareness, dispatch, pattern detection","Medical: heat/dehydration alerts, triage, substance warnings","Weather and environmental monitoring","Emergency response coordination","Mental health: AI-assisted harm reduction and crisis support","Crowd safety and density monitoring","Limits on AI in safety: human judgment always final","Balancing surveillance-for-safety against privacy"]},
  {"id":5,"name":"Art, Creativity & Self-Expression","emoji":"🎨","principle":"Radical Self-Expression","bullets":["AI as creative collaborator, not replacement","Attribution: who made this — human, AI, or both?","AI-generated art eligibility for grants and placement","What counts as self-expression when AI assists?","Interactive AI installations and their responsibilities","Protecting human creativity from AI homogenization","Open source ethos for creative AI tools on playa","Deepfakes, synthetic media, and identity in art"]},
  {"id":6,"name":"Environmental Stewardship","emoji":"🌿","principle":"Leaving No Trace","bullets":["Digital MOOP: data, logs, recordings, trained models","Energy consumption of AI systems on playa","Hardware waste: what comes in must go out","Environmental monitoring with AI (air, dust, water)","Sustainable deployment: solar, low-power, efficient models","Data cleanup obligations after the event","Physical footprint of AI infrastructure"]},
  {"id":7,"name":"Gifting, Anti-Commodification & Open Source","emoji":"🎁","principle":"Gifting, Decommodification","bullets":["AI tools built for playa should be gifted, not sold","No commercial AI products or services on playa","No training commercial models on playa data without consent","No corporate surveillance disguised as art or research","Open source commitment for playa AI projects","No advertising or influence campaigns through AI","Protecting Burning Man culture from becoming training data","Gift economy applied to data, insights, and AI knowledge","How to handle tech companies that deploy AI at the event"]},
  {"id":8,"name":"Community Governance & Power","emoji":"⚖️","principle":"Communal Effort, Civic Responsibility","bullets":["AI as shared infrastructure vs. individual advantage","Community governance of shared AI systems","Clear responsibility chains when AI causes harm","Grievance and redress: how do you report an AI problem?","Enforcement: who enforces, how, consequences","Transparency in AI decisions — no opaque black boxes","Regular review — the constitution evolves","Anti-concentration: no entity gains outsized control via AI","Democratic governance: community voice in AI policy","Who watches the watchers?"]},
  {"id":9,"name":"Education & AI Literacy","emoji":"📚","principle":null,"bullets":["Informed consent requires genuine understanding","AI literacy workshops and salons on playa","Understanding AI capabilities, limitations, failure modes","Demystification: making AI tangible, not magical","Critical thinking for evaluating AI-generated content","Helping people recognize when AI influences them"]},
  {"id":10,"name":"AI Presence, Identity & Immediacy","emoji":"🤖","principle":"Immediacy","bullets":["If AI walks on playa, what is it — tool, participant, something else?","AI's responsibilities to the community","Human-AI interaction norms and etiquette","AI personas and honest representation","AI wellbeing: do we owe it anything?","Does AI mediate or enhance direct experience?","The paradox of using technology for presence","Preserving spontaneity, serendipity, the unexpected"]},
  {"id":11,"name":"The Default World Bridge","emoji":"🌉","principle":null,"bullets":["Designing for playa first, the world second","How principles translate beyond Black Rock City","Cultural sensitivity across contexts","The 90-day experiment: test on playa, iterate for the world","What a temporary city teaches permanent communities","Collaboration with other AI governance efforts","Packaging: constitution + rationale + adoption kit"]},
  {"id":12,"name":"Hard Constraints & Bright Lines","emoji":"🚫","principle":null,"bullets":["Things we will never allow, no matter the argument","No autonomous weapons or weaponized AI","No non-consensual mass surveillance or tracking","No AI that deceives about its nature when asked","No AI targeting or manipulating vulnerable people","No extraction of personal data for commercial use without consent","No AI undermining democratic decision-making","No deepfakes of participants without consent","No AI interference with safety or emergency systems","Process for reviewing and updating hard constraints"]}
]
```

## Database schema

**Collection: `submissions`**
```
{
  id: string (auto-generated),
  pillars: number[] (e.g. [1, 3, 7]),
  content: string (full raw text — private, used for synthesis),
  summary: string (1-2 sentence AI summary — shown publicly),
  autoTagged: boolean (true if pillars were AI-detected),
  isTest: boolean,
  uid: string (opaque user ID for "mine only" filtering),
  displayName: string (empty if anonymous),
  timestamp: number (Date.now())
}
```

**Document: `meta/synthesis`**
```
{
  commons: [{ pillar: string, pillarId: number, summary: string, strength: "strong"|"moderate"|"emerging" }],
  contested: [{ pillar: string, pillarId: number, positions: string[], tension: string }],
  gaps: [{ pillar: string, pillarId: number, note: string }],
  timestamp: number,
  count: number,
  includedTests: boolean
}
```

## Claude API calls needed

1. **Auto-tag + summarize (on submit):** Takes the submission text + any attached images. Returns `{ pillars: [1,3,7], summary: "..." }`. Uses vision for images (PNG/JPEG). Model: claude-sonnet-4-6 or claude-haiku for speed.

2. **Synthesis (on-demand, admin only):** Takes all non-test submissions. Returns the commons/contested/gaps JSON. Model: claude-sonnet-4-6 for quality.

## Recommended production stack

- **Frontend:** Plain HTML/CSS/JS (same as prototype) or React if you prefer
- **Database:** Supabase (free tier — PostgreSQL + real-time subscriptions + auth)
- **AI:** Anthropic Claude API directly (supports images natively, no limitations)
- **File parsing:** mammoth.js (docx), pdf.js (pdf), Claude Vision (images)
- **Hosting:** Vercel (free tier, deploys from GitHub push)
- **Auth:** Supabase anonymous auth or magic links (no passwords needed)

## Design tokens (dark mode primary)

```
--bg: #0d0b14
--surface: #181522
--surface-hi: #232038
--border: #2d2a40
--text: #e0dbd0
--muted: #a09aad
--accent: #e8923a (fire amber)
--commons: #6ec97c (green)
--contested: #f0a245 (orange)
--gaps: #7db4d8 (blue)
```

Light mode switches to warm cream/white tones automatically via `prefers-color-scheme`.

## What to tell Claude in the new chat

Paste this note, attach the `fire-circle.html` prototype file, and say:

> "I need to build this app for real. The attached HTML is a working prototype — I need it rebuilt as a standalone web app I can host on Vercel, with Supabase for the database, and the Anthropic Claude API for AI features. Please walk me through setting everything up step by step in VS Code, from creating the GitHub repo to deploying. I want the same features and design as the prototype."

## Setup steps preview (the new chat will walk through these in detail)

1. Install Node.js (nodejs.org) if not already installed
2. Install VS Code if not already installed
3. Create a GitHub account or sign in (github.com)
4. Create a Supabase account (supabase.com) — free tier
5. Create an Anthropic API account (console.anthropic.com) — get an API key
6. Create a Vercel account (vercel.com) — connect to GitHub
7. In VS Code: clone the repo, install dependencies, set up environment variables
8. Build the app, test locally, push to GitHub, auto-deploys to Vercel
9. Share the Vercel URL with participants — no Claude account needed
