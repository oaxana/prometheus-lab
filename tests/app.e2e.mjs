import { launch, runWizard, openSubs, asAdmin } from './lib.mjs';


const B = 'http://localhost:4173';
const SHOTS = new URL('.', import.meta.url).pathname;
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(ok ? 'PASS' : 'FAIL', name, extra); };

const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, colorScheme: 'dark' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('status of 401')) errors.push(m.text()); });  // the expired-admin-session test causes one expected 401
const dialogs = [];
page.on('dialog', async (d) => { dialogs.push(d.message()); await d.accept(); });

await page.goto(B);
await page.waitForSelector('.hero-cta');
check('home no longer shows the three live-count boxes', (await page.locator('.stat, .home-stats').count()) === 0);
check('home headline reads "Humans and AI coexist together"', (await page.locator('h1').innerText()).trim() === 'Help shape how Humans and AI coexist together');
check('home has hero headline, "Start here" CTA, no trust line under it, 3 step cards, context + trust blocks, footer',
  (await page.locator('h1').innerText()).includes('Humans and AI') && await page.locator('.hero-cta:has-text("Start here")').isVisible() &&
  (await page.locator('main :text("Anonymous by default")').count()) === 0 && (await page.locator('.step-card').count()) === 3 &&
  await page.locator('h2:has-text("What\'s a constitution here?")').isVisible() && await page.locator('.trust-card h2:has-text("Built on trust")').isVisible() &&
  await page.locator('.trust-card :text("Your email stays private.")').isVisible() &&
  await page.locator('.home-footer:has-text("AI-cautious voices both welcome")').isVisible());
check('legacy browser uid is no longer created', (await page.evaluate(() => localStorage.getItem('prometheus-lab-uid'))) === null);
check('no horizontal scroll at phone width', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
await page.screenshot({ path: SHOTS + 'screens/shot-home.png', fullPage: true });

// Locked tabs for someone with no contribution yet
check('Pillars, Voices and Synthesis show locked (dimmed, lock icon); Home and Submit do not',
  (await page.locator('nav button.locked').count()) === 3 && (await page.locator('nav button.locked .ti-lock').count()) === 3 &&
  (await page.locator('nav button.locked').allInnerTexts()).join().includes('Voices') && !(await page.locator('nav button:has-text("Submit")').getAttribute('class')).includes('locked') && (await page.locator('nav button.locked').first().evaluate((e) => getComputedStyle(e).opacity)) === '0.45');
const lockedView = async (h) => await page.locator('.locked-panel h2:has-text("Unlocks after your first submission")').isVisible() && await page.locator(`.locked-ghost h2:has-text("${h}")`).count() === 1;
await page.click('nav button:has-text("Pillars")');
check('locked Pillars: opens a faded placeholder with the unlock message, no real pillar names', await lockedView('The Pillars') && (await page.locator('main :text("Consent, Privacy")').count()) === 0 && (await page.locator('.locked-ghost').evaluate((e) => +getComputedStyle(e).opacity)) < 0.3);
await page.click('nav button:has-text("Voices")');
check('locked Voices: placeholder only, no real cards', await lockedView('All Voices') && (await page.locator('.submission-card').count()) === 0);
await page.click('nav button:has-text("Synthesis")');
check('locked Synthesis: placeholder only, no create button', await lockedView('Collective Synthesis') && (await page.locator('button:has-text("Create")').count()) === 0);
await page.click('.locked-panel button:has-text("Start here")');
check('"Start here" on a locked tab opens the Submit tab', await page.locator('.verify-card').isVisible());
await page.click('nav button:has-text("Home")'); await page.click('.hero-cta');
check('"Start here" opens the Submit tab', await page.locator('.verify-card').isVisible());
await page.click('nav button:has-text("Home")'); await page.click('.step-card >> nth=0');
check('step 1 card ("Share") opens the Submit tab', await page.locator('.verify-card').isVisible());
await page.click('nav button:has-text("Home")'); await page.click('.step-card >> nth=1');
check('step 2 card ("Map") opens Pillars (locked placeholder here)', await lockedView('The Pillars'));
await page.click('nav button:has-text("Home")'); await page.click('.step-card >> nth=2');
check('step 3 card ("Synthesize") opens Synthesis (locked placeholder here)', await lockedView('Collective Synthesis'));
await page.click('nav button:has-text("Home")');

// Submit tab: typed text must survive toggling anonymous + a background refresh
await page.click('nav button:has-text("Submit")');
check('unverified participant sees privacy-conscious verification', await page.locator('text=Verify you’re one participant').isVisible() && (await page.locator('.verify-card').innerText()).includes('never included in synthesis'));
const unauthInsert = await page.evaluate(async () => (await sb.rpc('submit_submission',{p_pillars:[1],p_content:'forged',p_summary:'x',p_auto_tagged:false,p_is_test:false,p_anonymous:true})).error?.message||'');
check('unauthenticated participant cannot create a real submission', unauthInsert.includes('Authentication'));
await page.fill('#auth-email','ember@example.com');await page.click('button:has-text("Send code")');
await page.waitForSelector('#auth-code');
check('OTP input is limited to the configured six digits',await page.locator('#auth-code').getAttribute('maxlength')==='6');
await page.fill('#auth-code','123456');await page.click('button:has-text("Verify")');
await page.waitForSelector('.auth-status:has-text("Verified participant")');
check('OTP verifies participant', true);
await page.reload();await page.click('nav button:has-text("Submit")');await page.waitForSelector('.auth-status');
check('returning authenticated session remains usable', await page.locator('.auth-status:has-text("Verified participant")').isVisible());
// Wizard step 1: the name box and the toggles survive re-renders; both toggles use the same amber
await page.waitForSelector('#wz-start');
check('step 1 defaults to "With my name" (anonymous is off)', (await page.locator('[data-fk=anon-off]').getAttribute('aria-pressed')) === 'true' && (await page.locator('[data-fk=anon]').getAttribute('aria-pressed')) === 'false');
await page.click('[data-fk=anon]');
check('choosing Anonymous hides the name box and selects it in amber', (await page.locator('#display-name').count()) === 0 && (await page.locator('[data-fk=anon]').evaluate((e) => getComputedStyle(e).borderTopColor)) === 'rgb(239, 159, 39)');
await page.click('[data-fk=anon-off]');
check('regular participant: no test switch or test wording on step 1', (await page.locator('[data-fk=test]').count()) === 0 && !/\btest/i.test(await page.locator('main').innerText()));
await page.click('#wz-start');
check('"Get started" without a name shows a pop-up and stays on step 1', await page.locator('.wz-popup').isVisible() && (await page.locator('.wz-stepcount').innerText()).includes('Step 1 of'));
await page.click('#wz-popup-name');
check('"Enter my name" closes the pop-up and focuses the name box', (await page.locator('.wz-popup').count()) === 0 && (await page.evaluate(() => document.activeElement?.id)) === 'display-name');
await page.fill('#display-name', 'Ember "<b>x</b>"');
check('typing a name enables "Get started"', await page.locator('#wz-start').isEnabled());
await page.click('[data-fk=anon]'); await page.click('[data-fk=anon-off]');   // re-render twice
check('display name survives + quotes escaped', (await page.inputValue('#display-name')) === 'Ember "<b>x</b>"');
await page.screenshot({ path: SHOTS + 'screens/shot-submit.png', fullPage: true });
await runWizard(page, { text: 'AI should always disclose itself on playa.', choice: 'not_sure', resume: true });   // step 1 was set up by hand above
check('lands on the confirmation step', await page.locator('h2:has-text("Your voice is in the lab now")').isVisible());
check('tabs unlock right after the first submission, without a reload', (await page.locator('nav button.locked').count()) === 0 && (await page.locator('nav button .ti-lock').count()) === 0);
check('history lists the new submission with its summary', (await page.locator('.wz-hrow .wz-hsum').first().innerText()) === 'A short summary.');
await page.click('nav button:has-text("Pillars")');
await page.click('button:has-text("Expand all")');
check('pillars expand all', (await page.locator('.pillar-ref-body.open').count()) === 8);
await page.screenshot({ path: SHOTS + 'screens/shot-pillars.png', fullPage: false });
await page.click('nav button:has-text("Home")');
const realRows = (await (await fetch(B + '/__db')).json()).submissions.filter((r) => !r.is_test);
check('one real submission saved; home still has no count boxes', realRows.length === 1 && (await page.locator('.stat').count()) === 0);
await page.click('nav button:has-text("Voices")'); await page.waitForSelector('.submission-card'); await openSubs(page);
check('card shows AI summary, not raw text', (await page.locator('.summary-text').first().innerText()) === 'A short summary.');
check('auto-tagged badge + pillar pills (1 and 3)', (await page.locator('.pill.auto').count()) === 2);
check('"yours" badge', await page.locator('.mine-badge').isVisible());
check('name escaped, not injected', (await page.locator('.submission-meta').first().innerText()).includes('Ember "<b>x</b>"'));
const storedRow=(await (await fetch(B+'/__db')).json()).submissions.at(-1);
check('real row is owned by auth participant, not browser uid', !!storedRow.participant_id && storedRow.uid===null);
check('wizard metadata saved: pillar choice, input mode, discovery link', storedRow.pillar_choice==='not_sure' && storedRow.input_mode==='text' && !!storedRow.discovery_input_id);
const log = await (await fetch(B + '/__log')).json();
const call = log.filter((x) => x.anthropic).pop().anthropic;
check('typed text reached the summarizer', JSON.stringify(call.messages[0].content).includes('AI should always disclose itself'));

// Raw text expander
await page.click('.raw-toggle');
check('own raw text expands', (await page.locator('.raw-content.show').innerText()).includes('AI should always disclose'));

// Privacy: a second browser profile must not see raw text / "yours"
const ctx2 = await browser.newContext({ viewport: { width: 420, height: 900 } });
const p2 = await ctx2.newPage();
await p2.goto(B); await p2.waitForSelector('.hero-cta');
check('other user with no submission of their own is locked out of Pillars/Voices/Synthesis', (await p2.locator('nav button.locked').count()) === 3);
await p2.click('nav button:has-text("Voices")');
check('locked Voices shows the placeholder, no cards, for the other user', await p2.locator('.locked-panel').isVisible() && (await p2.locator('.submission-card').count()) === 0);
await p2.click('nav button:has-text("Home")');
// the lock is a courtesy; the real privacy boundary is the server, so check what the database hands another browser
const rows2 = await p2.evaluate(async () => (await sb.rpc('list_submissions', {})).data);
check('other user (server level): sees the summary but never raw text, "yours" or owner-only fields', rows2.length === 1 && rows2[0].summary === 'A short summary.' && rows2[0].mine === false && rows2[0].content === null && rows2[0].file_url === null);
check('other user: raw text not anywhere in DOM', !(await p2.content()).includes('disclose itself on playa'));
await p2.close(); await ctx2.close();

// Admin page: a muted footer link, password checked by the server, "Unlock all tabs" just for this browser session
const actx = await browser.newContext({ viewport: { width: 420, height: 900 } });
const ap = await actx.newPage(); const aerr = []; ap.on('pageerror', (e) => aerr.push(String(e)));
await ap.goto(B); await ap.waitForSelector('.hero-cta');
check('admin link sits in the home footer, small and muted', await ap.locator('.admin-link-row .admin-link:has-text("Admin")').isVisible() && parseFloat(await ap.locator('.admin-link').evaluate((e) => getComputedStyle(e).fontSize)) <= 12 && parseFloat(await ap.locator('.admin-link').evaluate((e) => getComputedStyle(e).opacity)) < 1);
await ap.click('.admin-link:has-text("Admin")'); await ap.waitForSelector('#admin-password');
check('admin page asks for a password (masked); no controls before login', (await ap.locator('#admin-password').getAttribute('type')) === 'password' && (await ap.locator('.admin-control').count()) === 0);
await ap.fill('#admin-password', 'wrong'); await ap.click('.admin-login button');
await ap.waitForSelector('.admin-login .auth-error');
check('wrong admin password rejected by the server', (await ap.locator('.admin-login .auth-error').innerText()).includes('isn’t right') && (await ap.locator('.admin-control').count()) === 0 && (await ap.evaluate(() => S.isAdmin)) === false);
check('no admin cookie after a wrong password', !(await actx.cookies()).some((c) => c.name === 'pl_admin'));
await ap.fill('#admin-password', 'letmein'); await ap.click('.admin-login button');
await ap.waitForSelector('.admin-control');
const ac = (await actx.cookies()).find((c) => c.name === 'pl_admin');
check('right password: admin cookie is HttpOnly, SameSite=Strict, session-only, never the password', !!ac && ac.httpOnly && ac.sameSite === 'Strict' && ac.expires === -1 && !ac.value.includes('letmein'));
check('password is not kept in browser storage', !(await ap.evaluate(() => JSON.stringify({ ...sessionStorage }) + JSON.stringify({ ...localStorage }))).includes('letmein'));
check('admin v1 has exactly one control: Unlock all tabs (off)', (await ap.locator('.admin-control').count()) === 1 && (await ap.locator('.admin-control h3').innerText()) === 'Unlock all tabs' && (await ap.locator('.admin-switch').getAttribute('aria-checked')) === 'false');
check('logging in alone does not unlock the tabs', (await ap.locator('nav button.locked').count()) === 3);
await ap.screenshot({ path: SHOTS + 'screens/shot-admin.png', fullPage: true });
await ap.click('.admin-switch');
check('switch on: Pillars, Voices and Synthesis unlock without a submission', (await ap.locator('.admin-switch').getAttribute('aria-checked')) === 'true' && (await ap.locator('nav button.locked').count()) === 0);
await ap.click('nav button:has-text("Voices")');
check('unlocked Voices opens', await ap.locator('h2:has-text("All Voices")').isVisible());
await ap.reload(); await ap.waitForSelector('.hero-cta'); await ap.waitForFunction(() => S.adminChecked);
check('unlock survives a reload (same browser session)', (await ap.locator('nav button.locked').count()) === 0);
const ap2 = await actx.newPage(); await ap2.goto(B); await ap2.waitForFunction(() => S.adminChecked);
check('unlock applies to a second tab of the same browser', (await ap2.locator('nav button.locked').count()) === 0);
await ap2.close();
const octx = await browser.newContext(); const op = await octx.newPage(); await op.goto(B); await op.waitForSelector('.hero-cta');
check('another visitor is still locked (unlock is per admin browser)', (await op.locator('nav button.locked').count()) === 3);
await octx.close();
await actx.addCookies([{ name: 'pl_admin', value: 'forged', url: B }]);   // replaces the real (HttpOnly) cookie
await ap.reload(); await ap.waitForFunction(() => S.adminChecked);
check('a forged admin cookie is not accepted, so the unlock no longer counts', (await ap.evaluate(() => S.isAdmin)) === false && (await ap.locator('nav button.locked').count()) === 3);
await ap.goto('about:blank'); await ap.goto(B + '/#admin'); await ap.waitForSelector('#admin-password');
await ap.fill('#admin-password', 'letmein'); await ap.press('#admin-password', 'Enter'); await ap.waitForSelector('.admin-control');
check('#admin opens the admin page directly; Enter submits', true);
await ap.click('button:has-text("Log out of admin")'); await ap.waitForSelector('#admin-password');
check('log out: back to the password form, admin cookie gone, tabs locked again', !(await actx.cookies()).some((c) => c.name === 'pl_admin' && c.value) && (await ap.locator('nav button.locked').count()) === 3);
check('admin page: no page errors', aerr.length === 0, aerr.join('|'));
await actx.close();

// Mine-only + show tests filters
await page.click('.toggle-row:has-text("Mine only")');
check('mine-only keeps own card', (await page.locator('.submission-card').count()) === 1);
await page.screenshot({ path: SHOTS + 'screens/shot-voices.png', fullPage: true });

// Test submissions are admin-only: a regular participant sees no switch for them on Voices
await page.click('nav button:has-text("Voices")'); await page.waitForSelector('.submission-card');
check('regular participant: no "Show tests" switch and no "Mark as test" button', (await page.locator('.toggle-row:has-text("Show tests")').count()) === 0 && (await page.locator('button:has-text("Mark as test")').count()) === 0);
// As admin: a test submission with one hand-picked pillar, then show/hide tests
await asAdmin(ctx, B); await page.reload(); await page.waitForSelector('.hero-cta'); await page.waitForFunction(() => S.isAdmin);
await runWizard(page, { text: 'just testing', test: true, pillars: [5] });
await page.click('nav button:has-text("Voices")'); await page.waitForSelector('.submission-card');
await page.click('.toggle-row:has-text("Show tests")');
check('test card appears when "Show tests" on', (await page.locator('.test-card').count()) === 1);
check('user-selected pillar kept & not auto-tagged', (await page.locator('.test-card .pill').count()) === 1 && (await page.locator('.test-card .pill.auto').count()) === 0);
await ctx.clearCookies({ name: 'pl_admin' }); await page.reload(); await page.waitForSelector('.hero-cta');   // back to a regular participant
await page.click('nav button:has-text("Voices")'); await page.waitForSelector('.submission-card');
check('after admin logout the test card is hidden again, even though "Show tests" was on', (await page.locator('.test-card').count()) === 0 && (await page.locator('.toggle-row:has-text("Show tests")').count()) === 0);

const m = await (await fetch(B + '/api/metrics')).json();
check('metrics API leaves out test rows and exposes only three counts', JSON.stringify(Object.keys(m).sort()) === '["contributions","pillarsCovered","voices"]' && m.contributions === 1 && m.voices === 1);
check('metrics API is GET-only', (await fetch(B + '/api/metrics', { method: 'POST' })).status === 405);

// Phone: all five tabs fit across the screen (the last one used to be cut off on the right)
const pctx = await browser.newContext({ viewport: { width: 375, height: 740 }, isMobile: true, hasTouch: true }); const pp = await pctx.newPage();
await pp.goto(B); await pp.waitForSelector('.hero-cta');
const navFit = await pp.evaluate(() => ({ right: Math.max(...[...document.querySelectorAll('nav button')].map((b) => b.getBoundingClientRect().right)), w: innerWidth, sw: document.documentElement.scrollWidth, nav: [document.getElementById('nav').scrollWidth, document.getElementById('nav').clientWidth] }));
check('phone: all 5 tabs fit the 375px screen and the page does not scroll sideways', navFit.right <= navFit.w && navFit.sw <= navFit.w && navFit.nav[0] <= navFit.nav[1], JSON.stringify(navFit));
await pp.click('nav button:has-text("Submit")'); await pp.waitForSelector('#auth-email');
check('phone: the email box is 16px so iPhone Safari does not zoom in on it', (await pp.locator('#auth-email').evaluate((e) => getComputedStyle(e).fontSize)) === '16px');
await pctx.close();
// Home fits a laptop screen: everything down to and including the "What's a constitution here?" card is visible without scrolling
const fctx = await browser.newContext({ viewport: { width: 1280, height: 650 } }); const fp = await fctx.newPage();
await fp.goto(B); await fp.waitForSelector('.hero-cta');
const fit = await fp.evaluate(() => ({ bottom: document.querySelector('.info-card').getBoundingClientRect().bottom, h: innerHeight, h1w: document.querySelector('h1').getBoundingClientRect().height }));
check('home: constitution card fits a 1280x650 laptop view; headline on one line', fit.bottom <= fit.h && fit.h1w < 45, JSON.stringify(fit));
check('home: "What\'s a constitution here?" and "Built on trust" cards are the same height, each with an icon', new Set(await fp.locator('.info-card').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)))).size === 1 && (await fp.locator('.info-card .info-icon').count()) === 2);
await fctx.close();

// Synthesis: locked first
await page.click('nav button:has-text("Synthesis")');
check('locked: no create button', (await page.locator('button:has-text("Create New Synthesis")').count()) === 0);
check('locked: lead-only message', await page.locator('text=Only the project lead can create a synthesis.').isVisible());
check('no admin button or link on the Synthesis page', (await page.locator('main button, main a').filter({ hasText: /unlock|admin|project lead/i }).count()) === 0);
await page.click('nav button:has-text("Home")'); await page.click('.admin-link:has-text("Admin")');
await page.fill('#admin-password', 'letmein'); await page.click('.admin-login button'); await page.waitForSelector('.admin-control');
await page.click('nav button:has-text("Synthesis")');
await page.waitForSelector('button:has-text("Create New Synthesis")');
check('unlocked: 1 eligible contribution (tests excluded), no "reads all" note', await page.waitForFunction((n) => S.synStatusState === 'ok' && S.synStatus.eligible.contributions === n, 1).then(() => true, () => false) && (await page.locator('.syn-run-note').count()) === 0);
await page.click('.toggle-row:has-text("Include test submissions")');
check('include-tests updates count', await page.waitForFunction((n) => S.synStatusState === 'ok' && S.synStatus.eligible.contributions === n, 2).then(() => true, () => false));
await page.click('.toggle-row:has-text("Include test submissions")');
await page.click('button:has-text("Create New Synthesis")');
await page.waitForSelector('.syn-sec');
check('three section groups rendered and all start collapsed', (await page.locator('.syn-sec').count()) === 3 && (await page.locator('.syn-shead[aria-expanded=true]').count()) === 0);
await page.click('#acc-syn-commons .syn-shead'); await page.click('#acc-syn-commons .syn-phead'); await page.waitForTimeout(450);
check('LLM html is escaped', (await page.locator('#acc-syn-commons .syn-detail').innerHTML()).includes('&lt;b&gt;disclosure&lt;/b&gt;'));
check('snapshot header: date · voices · contributions on one line, no version text', /^[A-Z][a-z]+ \d{1,2}, \d{4} \/ 1 voice \/ 1 contribution$/.test((await page.locator('.syn-meta').innerText()).replace(/\s+/g, ' ')));
await page.screenshot({ path: SHOTS + 'screens/shot-synthesis.png', fullPage: true });

// The server checks the admin cookie on every run: once it is gone, the run is refused and the controls disappear
const noCookie = await fetch(B + '/api/synthesize', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
check('synthesis API refuses a request without the admin cookie', noCookie.status === 401);
await page.click('.toggle-row:has-text("Include test submissions")');   // including the test row is new material, so the button returns
await page.waitForSelector('button:has-text("Create New Synthesis")');
await ctx.clearCookies({ name: 'pl_admin' });
await page.click('button:has-text("Create New Synthesis")');
await page.waitForEvent('dialog');
await page.waitForFunction(() => !S.synthesizing);
check('expired admin session -> alert + run controls hidden', dialogs.some((d) => d.includes('admin session has ended')) && (await page.locator('button:has-text("Create New Synthesis")').count()) === 0);

// Light mode renders (prefers-color-scheme)
const lctx = await browser.newContext({ viewport: { width: 420, height: 900 }, colorScheme: 'light' });
const lp = await lctx.newPage(); await lp.goto(B);
check('light mode bg is cream', (await lp.evaluate(() => getComputedStyle(document.body).backgroundColor)) === 'rgb(248, 245, 239)');
check('dark mode bg is #0d0b14', (await page.evaluate(() => getComputedStyle(document.body).backgroundColor)) === 'rgb(13, 11, 20)');

// Explicit sign-out removes private ownership access on this browser.
check('green box has one button only: the clickable name (no Edit name / Sign out there)', (await (async () => { await page.click('nav button:has-text("Submit")'); return page.locator('.auth-status button').allInnerTexts(); })()).length === 1 && !/sign out|edit name/i.test(await page.locator('.auth-status').innerText()));
await page.click('nav button:has-text("Home")');await page.click('.admin-link-row button:has-text("Sign out")');await page.click('nav button:has-text("Submit")');await page.waitForSelector('.verify-card');
check('sign out returns to participant verification', await page.locator('.verify-card').isVisible());
check('after sign-out the tabs lock again', (await page.locator('nav button.locked').count()) === 3);
check('signed-out browser no longer receives private raw text', (await page.evaluate(() => S.submissions.every((x) => x.content === null && !x.mine))));

check('no console/page errors', errors.length === 0, errors.join(' | '));
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
await browser.close();
