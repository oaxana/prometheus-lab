// A transcript submitted as an uploaded .md file (meeting-tool export) in a real browser:
// the "what matters to you" step is skipped, speakers are cleaned and listed before saving,
// and the text file is stored as the source text (not copied to Storage).
import { launch, openSubs } from './lib.mjs';
const B = 'http://localhost:4173'; let pass = 0, total = 0;
const check = (n, ok, x = '') => { total++; if (ok) pass++; console.log(ok ? 'PASS' : 'FAIL', n, x); };
const b = await launch();
const p = await (await b.newContext({ viewport: { width: 420, height: 900 }, colorScheme: 'dark' })).newPage();
const errs = []; p.on('pageerror', (e) => errs.push(String(e))); p.on('dialog', (d) => d.accept());
const NEXT = '.wz-nav .btn-amber';
const md = `# Constitution workshop

**Meeting Date:** 1st Oct, 2026 - 2:38 AM

---

**jordan lee** *[10:23]*: Consent should be explicit.
**Robin O'Hara - Example Studio Productions** *[12:19]*: Artists need a say.
**Casey M Park** *[13:01]*: Keep humans in the loop.
**Jordan Lee** *[13:05]*: And make it visible.
`;

await p.goto(B); await p.click('nav button:has-text("Submit")');
await p.fill('#auth-email', 'uploader@example.com'); await p.click('button:has-text("Send code")'); await p.fill('#auth-code', '123456'); await p.click('button:has-text("Verify")');
await p.waitForSelector('#wz-start');
await p.click('[data-fk=source-transcript]'); await p.click('#wz-start');
await p.waitForSelector('.wz-pillars');
check('transcript skips the "what does this source address" step and goes straight to pillars', (await p.locator('.wz-stepcount').innerText()).includes('Step 3') && (await p.locator('#discovery-text').count()) === 0);
await p.click('.wz-nav .btn-ghost'); await p.waitForSelector('#wz-start');
check('Back from pillars returns to the first screen', (await p.locator('[data-fk=source-transcript]').getAttribute('aria-pressed')) === 'true');
await p.click('#wz-start'); await p.waitForSelector('.wz-pillars');
await p.click('[data-fk=not_sure]'); await p.click(NEXT);
check('format step lists MD and TXT', (await p.locator('main').innerText()).includes('MD, TXT'));
await p.click('[data-fk=m-upload]'); await p.click(NEXT);
await p.setInputFiles('#wz-file', { name: 'Transcript_Sep30.md', mimeType: 'text/markdown', buffer: Buffer.from(md) });
await p.waitForSelector('.file-preview'); await p.waitForFunction(() => W.file && !W.file.busy);
check('an .md file is accepted and read', (await p.locator('.file-preview .name').innerText()) === 'Transcript_Sep30.md' && (await p.locator(NEXT).isEnabled()));
check('the title sits on the same step and is pre-filled from the file name', (await p.inputValue('#source-title')) === 'Transcript_Sep30.md');
await p.fill('#source-title', '');
check('a transcript cannot continue without a title', !(await p.locator(NEXT).isEnabled()));
await p.fill('#source-title', 'Constitution workshop, Oct 1 2026'); await p.click(NEXT);
await p.waitForSelector('.wz-speakers');
check('review lists the cleaned speaker names before saving', (await p.locator('.wz-speakers').innerText()) === "Jordan Lee, Robin O'Hara, Casey Park" && (await p.locator('text=Speakers found (3)').count()) === 1);
await p.click(NEXT); await p.waitForSelector('text=+ Submit another', { timeout: 20000 });
const db = await (await fetch(B + '/__db')).json();
const src = db.sources.at(-1);
check('the full .md text is stored as the source original', src.source_type === 'transcript' && src.raw_content === md.trim() && src.original_file_name === 'Transcript_Sep30.md' && src.original_file_url === null);
check('one contribution per cleaned speaker', db.submissions.filter((s) => s.source_id === src.id).length === 3 && db.sourceContributors.filter((x) => x.source_id === src.id).map((x) => x.source_label).join('|') === "Jordan Lee|Robin O'Hara|Casey Park");
check('a text file is not copied to Storage', db.objects.length === 0);

// "Mine only" is your own thoughts: the uploader manages these 3 speaker voices but none of them is the uploader
await p.click('nav button:has-text("Voices")'); await p.waitForSelector('.toggle-row:has-text("Mine only")'); await openSubs(p);
check('Voices: the 3 speakers are listed, but "Mine only" counts 0 for the uploader', (await p.locator('.submission-card').count()) === 3 && (await p.locator('.toggle-row:has-text("Mine only")').innerText()).replace(/\s+/g, ' ').trim() === 'Mine only (0)');
await p.click('.toggle-row:has-text("Mine only")'); await openSubs(p);
check('"Mine only" on: no speaker cards', (await p.locator('.submission-card').count()) === 0);
await p.click('.toggle-row:has-text("Mine only")'); await p.click('nav button:has-text("Submit")');

// A saved login the server no longer accepts: ask to verify again instead of a dead-end error, keep the entry
const dialogs = []; p.removeAllListeners('dialog'); p.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
await p.waitForSelector('#wz-start');   // coming back to Submit after a saved entry starts a fresh one
await p.click('[data-fk=anon]'); await p.click('#wz-start'); await p.click('[data-fk=dm-text]'); await p.fill('#discovery-text', 'Consent matters.'); await p.click(NEXT);
await p.waitForSelector('.wz-pillars'); await p.click(NEXT); await p.click('[data-fk=m-text]'); await p.click(NEXT);
await p.fill('#voice-text', 'Keep the stale-login text.'); await p.click(NEXT); await p.waitForSelector('.wz-title:has-text("Review and submit")');
await fetch(B + '/__wipeusers');
await p.click(NEXT); await p.waitForSelector('#auth-email', { timeout: 10000 });
check('stale login: friendly "verify again" message and the email form, not "Authentication required"', dialogs.some((m) => m.includes('verify your email again')) && !dialogs.some((m) => /^Error: Authentication required/.test(m)));
check('stale login: what you entered is kept', await p.evaluate(() => W.text === 'Keep the stale-login text.' && W.step === 6));
check('no page errors', errs.length === 0, errs.join('|'));
console.log(`\n${pass}/${total} passed`); await b.close();
