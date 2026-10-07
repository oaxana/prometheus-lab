import { launch, runWizard, openSubs } from './lib.mjs';


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
await page.waitForSelector('.stat-num');
await page.waitForFunction(() => document.querySelector('.stat-num')?.textContent !== '—');
check('home renders 3 live stats', (await page.locator('.stat').count()) === 3);
check('home shows 0 voices / 0 of 12 pillars / 0 contributions', (await page.locator('.stat-num').allInnerTexts()).join('|') === '0|0/12|0');
check('home has hero headline, CTA, trust line, 3 step cards, context + trust blocks, footer',
  (await page.locator('h1').innerText()).includes('humans and AI') && await page.locator('.hero-cta:has-text("Add your voice")').isVisible() &&
  await page.locator('.hero-trust:has-text("Anonymous by default")').isVisible() && (await page.locator('.step-card').count()) === 3 &&
  await page.locator('h2:has-text("What\'s a constitution here?")').isVisible() && await page.locator('h2:has-text("Built on trust")').isVisible() &&
  await page.locator('.home-footer:has-text("AI-cautious voices both welcome")').isVisible());
check('legacy browser uid is no longer created', (await page.evaluate(() => localStorage.getItem('prometheus-lab-uid'))) === null);
check('no horizontal scroll at phone width', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
await page.screenshot({ path: SHOTS + 'screens/shot-home.png', fullPage: true });

// Locked tabs for someone with no contribution yet
check('Pillars, Voices and Synthesis show locked (dimmed, lock icon); Home and Submit do not',
  (await page.locator('nav button.locked').count()) === 3 && (await page.locator('nav button.locked .ti-lock').count()) === 3 &&
  (await page.locator('nav button.locked').allInnerTexts()).join().includes('Voices') && !(await page.locator('nav button:has-text("Submit")').getAttribute('class')).includes('locked') && (await page.locator('nav button.locked').first().evaluate((e) => getComputedStyle(e).opacity)) === '0.45');
await page.click('nav button:has-text("Pillars")', { force: true });   // aria-disabled, but still clickable for a real person
check('locked Pillars: gentle toast, stays on Home', (await page.locator('.toast').innerText()) === 'Share your voice first, then explore the pillars' && await page.locator('.hero-cta').isVisible());
await page.click('nav button:has-text("Voices")', { force: true });
check('locked Voices: its own toast, stays on Home', (await page.locator('.toast').innerText()) === 'Share your voice first to see what others have shared' && await page.locator('.hero-cta').isVisible());
await page.click('nav button:has-text("Synthesis")', { force: true });
check('locked Synthesis: its own toast, no stacked toasts, stays on Home', (await page.locator('.toast').count()) === 1 && (await page.locator('.toast').innerText()) === 'Share your voice first to unlock this' && await page.locator('.hero-cta').isVisible());
await page.click('.hero-cta');
check('"Add your voice" opens the Submit tab', await page.locator('.verify-card').isVisible());
await page.click('nav button:has-text("Home")'); await page.click('.step-card.clickable');
check('step 1 card ("Share") opens the Submit tab', await page.locator('.verify-card').isVisible());
await page.click('nav button:has-text("Home")');
await page.click('.step-card >> nth=1');
check('step 2 and 3 cards are not links', await page.locator('.hero-cta').isVisible());

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
await page.click('[data-fk=test]');   // anonymous is on by default; now test is on too
const amber = async (k) => page.locator(`[data-fk=${k}] .wz-track`).evaluate((e) => getComputedStyle(e).backgroundColor);
check('anonymous and test toggles share the same amber when on', (await amber('anon')) === 'rgb(239, 159, 39)' && (await amber('test')) === 'rgb(239, 159, 39)', await amber('anon') + ' / ' + await amber('test'));
await page.click('[data-fk=test]');
await page.click('[data-fk=anon]');   // named submission
check('"Get started" is blocked until a name is chosen', await page.locator('#wz-start').isDisabled());
await page.fill('#display-name', 'Ember "<b>x</b>"');
check('typing a name enables "Get started"', await page.locator('#wz-start').isEnabled());
await page.click('[data-fk=test]'); await page.click('[data-fk=test]');   // re-render twice
check('display name survives + quotes escaped', (await page.inputValue('#display-name')) === 'Ember "<b>x</b>"');
await page.screenshot({ path: SHOTS + 'screens/shot-submit.png', fullPage: true });
await runWizard(page, { text: 'AI should always disclose itself on playa.', choice: 'not_sure', resume: true });   // step 1 was set up by hand above
check('lands on the confirmation step', await page.locator('h2:has-text("Your voice is in the lab now")').isVisible());
check('tabs unlock right after the first submission, without a reload', (await page.locator('nav button.locked').count()) === 0 && (await page.locator('nav button .ti-lock').count()) === 0);
check('history lists the new submission with its summary', (await page.locator('.wz-hrow .wz-hsum').first().innerText()) === 'A short summary.');
await page.click('nav button:has-text("Pillars")');
await page.click('button:has-text("Expand all")');
check('pillars expand all', (await page.locator('.pillar-ref-body.open').count()) === 12);
await page.screenshot({ path: SHOTS + 'screens/shot-pillars.png', fullPage: false });
await page.click('nav button:has-text("Home")');
await page.waitForFunction(() => document.querySelector('.stat-num')?.textContent === '1');
const realRows = (await (await fetch(B + '/__db')).json()).submissions.filter((r) => !r.is_test);
check('home counts refresh after a submission (1 voice, pillars covered, 1 contribution)', (await page.locator('.stat-num').allInnerTexts()).join('|') === `1|${new Set(realRows.flatMap((r) => r.pillars)).size}/12|1`);
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
await p2.click('nav button:has-text("Voices")', { force: true });
check('locked Voices does not navigate for the other user', await p2.locator('.hero-cta').isVisible() && (await p2.locator('.submission-card').count()) === 0);
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
await ap.click('.admin-link'); await ap.waitForSelector('#admin-password');
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

// Test submission with one hand-picked pillar, then show/hide tests
await runWizard(page, { text: 'just testing', test: true, pillars: [5] });
await page.click('nav button:has-text("Voices")'); await page.waitForSelector('.submission-card');
await page.click('.toggle-row:has-text("Show tests")');
check('test card appears when "Show tests" on', (await page.locator('.test-card').count()) === 1);
check('user-selected pillar kept & not auto-tagged', (await page.locator('.test-card .pill').count()) === 1 && (await page.locator('.test-card .pill.auto').count()) === 0);

const m = await (await fetch(B + '/api/metrics')).json();
check('metrics API leaves out test rows and exposes only three counts', JSON.stringify(Object.keys(m).sort()) === '["contributions","pillarsCovered","voices"]' && m.contributions === 1 && m.voices === 1);
check('metrics API is GET-only', (await fetch(B + '/api/metrics', { method: 'POST' })).status === 405);

// Home when the metrics service is down: section hides, rest of the page still works (separate page: the 500 is an expected console error)
await fetch(B + '/__metrics?m=fail');
const dctx = await browser.newContext({ viewport: { width: 375, height: 800 } }); const dp = await dctx.newPage();
await dp.goto(B); await dp.waitForSelector('.hero-cta'); await dp.waitForTimeout(800);
check('metrics failure hides the numbers gracefully', (await dp.locator('.home-stats').count()) === 0 && (await dp.locator('.step-card').count()) === 3);
await dctx.close(); await fetch(B + '/__metrics?m=ok');

// Synthesis: locked first
await page.click('nav button:has-text("Synthesis")');
check('locked: no run button', (await page.locator('button:has-text("Run synthesis")').count()) === 0);
check('locked: lead-only message', await page.locator('text=Only the project lead can trigger synthesis.').isVisible());
check('no admin button or link on the Synthesis page', (await page.locator('main button, main a').filter({ hasText: /unlock|admin|project lead/i }).count()) === 0);
await page.click('nav button:has-text("Home")'); await page.click('.admin-link');
await page.fill('#admin-password', 'letmein'); await page.click('.admin-login button'); await page.waitForSelector('.admin-control');
await page.click('nav button:has-text("Synthesis")');
await page.waitForSelector('button:has-text("Run synthesis")');
check('unlocked: run button shows 1 contribution (tests excluded)', (await page.locator('button:has-text("Run synthesis")').innerText()).includes('1 contributions'));
await page.click('.toggle-row:has-text("Include test submissions")');
check('include-tests updates count', (await page.locator('button:has-text("Run synthesis")').innerText()).includes('2 contributions'));
await page.click('.toggle-row:has-text("Include test submissions")');
await page.click('button:has-text("Run synthesis")');
await page.waitForSelector('.syn-sec');
check('three section groups rendered and all start collapsed', (await page.locator('.syn-sec').count()) === 3 && (await page.locator('.syn-shead[aria-expanded=true]').count()) === 0);
await page.click('#acc-syn-commons .syn-shead'); await page.click('#acc-syn-commons .syn-phead'); await page.waitForTimeout(450);
check('LLM html is escaped', (await page.locator('#acc-syn-commons .syn-detail').innerHTML()).includes('&lt;b&gt;disclosure&lt;/b&gt;'));
check('last-run line uses participant and contribution counts', (await page.locator('text=/Last run:.*1 participant.*1 contribution.*tests excluded/').count()) === 1);
await page.screenshot({ path: SHOTS + 'screens/shot-synthesis.png', fullPage: true });

// The server checks the admin cookie on every run: once it is gone, the run is refused and the controls disappear
const noCookie = await fetch(B + '/api/synthesize', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
check('synthesis API refuses a request without the admin cookie', noCookie.status === 401);
await ctx.clearCookies({ name: 'pl_admin' });
await page.click('button:has-text("Run synthesis")');
await page.waitForEvent('dialog');
await page.waitForFunction(() => !S.synthesizing);
check('expired admin session -> alert + run controls hidden', dialogs.some((d) => d.includes('admin session has ended')) && (await page.locator('button:has-text("Run synthesis")').count()) === 0);

// Light mode renders (prefers-color-scheme)
const lctx = await browser.newContext({ viewport: { width: 420, height: 900 }, colorScheme: 'light' });
const lp = await lctx.newPage(); await lp.goto(B);
check('light mode bg is cream', (await lp.evaluate(() => getComputedStyle(document.body).backgroundColor)) === 'rgb(248, 245, 239)');
check('dark mode bg is #0d0b14', (await page.evaluate(() => getComputedStyle(document.body).backgroundColor)) === 'rgb(13, 11, 20)');

// Explicit sign-out removes private ownership access on this browser.
await page.click('nav button:has-text("Submit")');await page.click('button:has-text("Sign out / switch")');await page.waitForSelector('.verify-card');
check('sign out returns to participant verification', await page.locator('.verify-card').isVisible());
check('after sign-out the tabs lock again', (await page.locator('nav button.locked').count()) === 3);
check('signed-out browser no longer receives private raw text', (await page.evaluate(() => S.submissions.every((x) => x.content === null && !x.mine))));

check('no console/page errors', errors.length === 0, errors.join(' | '));
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
await browser.close();
