import { launch, runWizard } from './lib.mjs';


const B = 'http://localhost:4173';
const SHOTS = new URL('.', import.meta.url).pathname;
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(ok ? 'PASS' : 'FAIL', name, extra); };

const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, colorScheme: 'dark' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('status of 401')) errors.push(m.text()); });  // the wrong-key test causes one expected 401
const dialogs = [];
page.on('dialog', async (d) => { dialogs.push(d.message()); if (d.type() === 'prompt') await d.accept('letmein'); else await d.accept(); });

await page.goto(B);
await page.waitForSelector('.stat-num');
check('home renders 3 stats', (await page.locator('.stat').count()) === 3);
check('home shows 0 voices', (await page.locator('.stat-num').first().innerText()) === '0');
check('legacy browser uid is no longer created', (await page.evaluate(() => localStorage.getItem('prometheus-lab-uid'))) === null);
await page.screenshot({ path: SHOTS + 'screens/shot-home.png' });

// Pillars tab
await page.click('nav button:has-text("Pillars")');
await page.click('button:has-text("Expand all")');
check('pillars expand all', (await page.locator('.pillar-ref-body.open').count()) === 12);
await page.screenshot({ path: SHOTS + 'screens/shot-pillars.png', fullPage: false });

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
check('history lists the new submission with its summary', (await page.locator('.wz-hrow .wz-hsum').first().innerText()) === 'A short summary.');
await page.click('nav button:has-text("Voices")'); await page.waitForSelector('.submission-card');
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
await p2.goto(B); await p2.click('nav button:has-text("Voices")'); await p2.waitForSelector('.submission-card');
check('other user: no raw toggle, no yours badge', (await p2.locator('.raw-toggle').count()) === 0 && (await p2.locator('.mine-badge').count()) === 0);
check('other user: sees summary', (await p2.locator('.summary-text').first().innerText()) === 'A short summary.');
const html2 = await p2.content();
check('other user: raw text not anywhere in DOM', !html2.includes('disclose itself on playa'));
await p2.close(); await ctx2.close();

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

// Synthesis: locked first
await page.click('nav button:has-text("Synthesis")');
check('locked: no run button', (await page.locator('button:has-text("Run synthesis")').count()) === 0);
check('locked: lead-only message', await page.locator('text=Only the project lead can trigger synthesis.').isVisible());
await page.click('button:has-text("Project lead? Unlock")');
await page.waitForSelector('button:has-text("Run synthesis")');
check('unlocked: run button shows 1 contribution (tests excluded)', (await page.locator('button:has-text("Run synthesis")').innerText()).includes('1 contributions'));
await page.click('.toggle-row:has-text("Include test submissions")');
check('include-tests updates count', (await page.locator('button:has-text("Run synthesis")').innerText()).includes('2 contributions'));
await page.click('.toggle-row:has-text("Include test submissions")');
await page.click('button:has-text("Run synthesis")');
await page.waitForSelector('.tag-commons');
check('commons/contested/gaps cards rendered', (await page.locator('.card .section-tag').count()) === 3);
check('LLM html is escaped', (await page.locator('.synthesis-item').first().innerHTML()).includes('&lt;b&gt;disclosure&lt;/b&gt;'));
check('last-run line uses participant and contribution counts', (await page.locator('text=/Last run:.*1 participant.*1 contribution.*tests excluded/').count()) === 1);
await page.screenshot({ path: SHOTS + 'screens/shot-synthesis.png', fullPage: true });

// Wrong key is rejected and re-locks
await page.evaluate(() => sessionStorage.setItem('prometheus-lab-admin', 'wrong'));
await page.reload(); await page.click('nav button:has-text("Synthesis")');
await page.click('button:has-text("Run synthesis")');
await page.waitForFunction(() => document.querySelector('button.raw-toggle')?.textContent.includes('Unlock'));
check('wrong key -> alert + re-lock', dialogs.some((d) => d.includes('not accepted')));

// Light mode renders (prefers-color-scheme)
const lctx = await browser.newContext({ viewport: { width: 420, height: 900 }, colorScheme: 'light' });
const lp = await lctx.newPage(); await lp.goto(B);
check('light mode bg is cream', (await lp.evaluate(() => getComputedStyle(document.body).backgroundColor)) === 'rgb(248, 245, 239)');
check('dark mode bg is #0d0b14', (await page.evaluate(() => getComputedStyle(document.body).backgroundColor)) === 'rgb(13, 11, 20)');

// Explicit sign-out removes private ownership access on this browser.
await page.click('nav button:has-text("Submit")');await page.click('button:has-text("Sign out / switch")');await page.waitForSelector('.verify-card');
check('sign out returns to participant verification', await page.locator('.verify-card').isVisible());
await page.click('nav button:has-text("Voices")');
check('signed-out browser no longer sees private raw controls', (await page.locator('button:has-text("Show your full submission")').count())===0);

check('no console/page errors', errors.length === 0, errors.join(' | '));
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
await browser.close();
