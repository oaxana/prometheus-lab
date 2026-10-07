// Voices tab: filter-aware counts, "Show tests" toggle colour, collapsible sections, Suggested Pillars.
import { launch, runWizard, openSubs } from './lib.mjs';
const B = 'http://localhost:4173'; let pass = 0, total = 0;
const check = (n, ok, x = '') => { total++; if (ok) pass++; console.log(ok ? 'PASS' : 'FAIL', n, x); };
const b = await launch(); const errs = [];
const mk = async () => { const pg = await (await b.newContext({ viewport: { width: 420, height: 900 }, colorScheme: 'dark' })).newPage(); pg.on('pageerror', (e) => errs.push(String(e))); return pg; };
const login = async (pg, email) => { await pg.goto(B); await pg.click('nav button:has-text("Submit")'); await pg.fill('#auth-email', email); await pg.click('button:has-text("Send code")'); await pg.fill('#auth-code', '123456'); await pg.click('button:has-text("Verify")'); await pg.waitForSelector('#wz-start'); };
const idea = (v) => fetch(B + '/__idea?v=' + encodeURIComponent(v));
const voices = async (pg) => { await pg.click('nav button:has-text("Voices")'); await pg.waitForSelector('.acc'); await pg.waitForFunction(() => !document.querySelector('#acc-suggested .acc-empty')?.textContent.includes('Loading')); };
const heading = async (pg) => (await pg.locator('h2').first().innerText()).replace(/\s+/g, ' ');
const mine = async (pg) => (await pg.locator('.toggle-row:has-text("Mine only")').innerText()).replace(/\s+/g, ' ');
const bg = (pg, sel) => pg.locator(sel).evaluate((e) => getComputedStyle(e).backgroundColor);
const settle = (pg) => pg.waitForTimeout(450);

const p = await mk(); await login(p, 'ada@example.com');
// 1. nothing suggested yet
await idea(''); await runWizard(p, { text: 'First voice' }); await voices(p);
check('empty state when nothing is suggested', await p.locator('#acc-suggested .acc-empty:has-text("No new pillars suggested yet.")').count() === 1);
check('Suggested Pillars header shows (0) and starts collapsed (▸)', (await p.locator('#acc-suggested .acc-head').innerText()).replace(/\s+/g, ' ').includes('Suggested Pillars (0)') && (await p.locator('#acc-suggested .acc-chev').innerText()) === '▸' && (await p.locator('#acc-suggested .acc-head').getAttribute('aria-expanded')) === 'false');
check('Submissions also starts collapsed (▸): the page lands with both sections closed', (await p.locator('#acc-submissions .acc-chev').innerText()) === '▸' && (await p.locator('#acc-submissions .acc-head').getAttribute('aria-expanded')) === 'false' && (await p.locator('#acc-body-submissions').evaluate((e) => e.getBoundingClientRect().height)) === 0);
check('chevron is bigger than before (19px, was 14px)', (await p.locator('#acc-submissions .acc-chev').evaluate((e) => getComputedStyle(e).fontSize)) === '19px');
await openSubs(p);
check('opening Submissions shows the cards (▾)', (await p.locator('#acc-submissions .acc-chev').innerText()) === '▾' && (await p.locator('#acc-submissions .submission-card').first().isVisible()));
check('collapsed section is out of the tab order and invisible', (await p.locator('#acc-body-suggested').getAttribute('inert')) !== null && (await p.locator('#acc-body-suggested').evaluate((e) => e.getBoundingClientRect().height)) === 0);

// 2. more voices: a named one, an anonymous one, a test one (all by Ada), then another person
await idea('Rest and Recovery Spaces'); await runWizard(p, { text: 'Named voice', anonymous: false, name: 'Ada' });
await idea('Sacred Silence'); await runWizard(p, { text: 'Silent voice' });
await idea('Test Only Idea'); await runWizard(p, { text: 'Test voice', test: true });
const q = await mk(); await login(q, 'bob@example.com');
await idea('rest and recovery spaces!'); await runWizard(q, { text: 'Bob voice' });

// 3. counts follow the filters (Ada: 3 real + 1 test; Bob: 1 real). Reload so Ada sees Bob's voice without waiting for the 20 s poll.
await p.reload(); await p.waitForSelector('.hero-cta'); await voices(p); await openSubs(p);
check('header: tests hidden -> real voices only (4)', (await heading(p)) === 'All Voices (4)', await heading(p));
check('Mine only count: 3 (tests hidden)', (await mine(p)) === 'Mine only (3)', await mine(p));
await p.click('.toggle-row:has-text("Show tests")');
check('Show tests on: header (4 + 1 test) and Mine only (4)', (await heading(p)) === 'All Voices (4 + 1 test)' && (await mine(p)) === 'Mine only (4)', (await heading(p)) + ' / ' + (await mine(p)));
check('Submissions count matches cards shown (5)', (await p.locator('#acc-submissions .acc-head').innerText()).includes('(5)') && (await p.locator('.submission-card').count()) === 5);
await p.click('.toggle-row:has-text("Mine only")');
check('Mine only + tests: header (3 + 1 test), Submissions (4)', (await heading(p)) === 'All Voices (3 + 1 test)' && (await p.locator('#acc-submissions .acc-head').innerText()).includes('(4)') && (await p.locator('.submission-card').count()) === 4, await heading(p));
await p.click('.toggle-row:has-text("Show tests")');
check('Mine only, tests hidden: header (3), Mine only (3), Submissions (3)', (await heading(p)) === 'All Voices (3)' && (await mine(p)) === 'Mine only (3)' && (await p.locator('#acc-submissions .acc-head').innerText()).includes('(3)'));
await p.click('.toggle-row:has-text("Mine only")');

// 4. toggle colours: Show tests uses the same accent as Mine only when on
const off = await bg(p, '.toggle-row:has-text("Show tests") .toggle');
await p.click('.toggle-row:has-text("Show tests")'); await settle(p);
const on = await bg(p, '.toggle-row:has-text("Show tests") .toggle');
await p.click('.toggle-row:has-text("Mine only")'); await settle(p);
const mineOn = await bg(p, '.toggle-row:has-text("Mine only") .toggle');
const accent = await p.evaluate(() => { const d = document.createElement('i'); d.style.background = 'var(--accent)'; document.body.append(d); const c = getComputedStyle(d).backgroundColor; d.remove(); return c; });
check('Show tests ON is the accent colour, identical to Mine only ON', on === accent && mineOn === accent, `${on} / ${mineOn} / ${accent}`);
check('Show tests OFF looks different from ON', off !== on);
await p.click('.toggle-row:has-text("Mine only")'); await p.click('.toggle-row:has-text("Show tests")');

// 5. Submissions accordion animates closed and open
await p.click('#acc-submissions .acc-head'); await settle(p);
check('collapse: chevron ▸, aria-expanded false, height 0, content inert', (await p.locator('#acc-submissions .acc-chev').innerText()) === '▸' && (await p.locator('#acc-submissions .acc-head').getAttribute('aria-expanded')) === 'false' && (await p.locator('#acc-body-submissions').evaluate((e) => e.getBoundingClientRect().height)) === 0 && (await p.locator('#acc-body-submissions').getAttribute('inert')) !== null);
check('header count stays visible while collapsed', (await p.locator('#acc-submissions .acc-head').innerText()).includes('Submissions (4)'));
await p.click('#acc-submissions .acc-head'); await settle(p);
check('expand: chevron ▾, cards visible, height free (none)', (await p.locator('#acc-submissions .acc-chev').innerText()) === '▾' && (await p.locator('.submission-card').first().isVisible()) && (await p.locator('#acc-body-submissions').evaluate((e) => e.style.maxHeight)) === 'none');
check('the transition is a max-height one', (await p.locator('#acc-body-submissions').evaluate((e) => getComputedStyle(e).transitionProperty)) === 'max-height');
await p.click('#acc-submissions .acc-head'); await settle(p);
await p.click('nav button:has-text("Home")'); await voices(p);
check('open/closed choice survives switching tabs', (await p.locator('#acc-submissions .acc-head').getAttribute('aria-expanded')) === 'false');
await p.click('#acc-submissions .acc-head'); await settle(p);

// 6. Suggested Pillars: grouped by theme, counts, names on hover/tap, tests hidden
check('Suggested Pillars (2): "Rest and Recovery Spaces" and "Sacred Silence" (test idea hidden)', (await p.locator('#acc-suggested .acc-head').innerText()).includes('Suggested Pillars (2)'));
await p.click('#acc-suggested .acc-head'); await settle(p);
check('expanded: two plain rows, name + count pill only', (await p.locator('.sugg-row').count()) === 2 && (await p.locator('.sugg-name').allInnerTexts()).join('|') === 'Rest and Recovery Spaces|Sacred Silence' && (await p.locator('.sugg-count').allInnerTexts()).join('|') === '(2)|(1)', (await p.locator('.sugg-name').allInnerTexts()).join('|'));
check('different wording of one theme merged into one entry', (await p.locator('.sugg-row:has-text("Rest and Recovery") .sugg-count').innerText()) === '(2)');
check('names hidden until hover', !(await p.locator('.sugg-who').first().isVisible()));
await p.locator('.sugg-count').first().hover();
check('hover shows named + anonymous suggesters', (await p.locator('.sugg-who').first().isVisible()) && (await p.locator('.sugg-who').first().innerText()) === 'Suggested by Ada, Anonymous', await p.locator('.sugg-who').first().innerText());
await p.mouse.move(5, 5);
await p.locator('.sugg-count').nth(1).click();
check('tap shows "Anonymous" for the anonymous suggester and closes on outside tap', (await p.locator('.sugg-who').nth(1).innerText()) === 'Suggested by Anonymous' && (await p.locator('.sugg-who').nth(1).isVisible()));
await p.mouse.click(5, 5);
check('tapping elsewhere closes it', !(await p.locator('.sugg-who').nth(1).isVisible()));
await p.screenshot({ path: 'screens/shot-voices-suggested.png', fullPage: true });
await p.click('.toggle-row:has-text("Show tests")');
check('Show tests brings the test-only suggestion in (3)', (await p.locator('#acc-suggested .acc-head').innerText()).includes('Suggested Pillars (3)') && (await p.locator('.sugg-row:has-text("Test Only Idea")').count()) === 1);
await p.click('.toggle-row:has-text("Show tests")');

// 7. server: names only, no ids, GET only, and answers that never became a submission are ignored
const raw = await (await fetch(B + '/api/suggested-pillars')).text();
check('API leaks no ids / emails / raw text', !/@|participant_id|[0-9a-f]{8}-[0-9a-f]{4}-/.test(raw) && !raw.includes('Bob voice'), raw.slice(0, 200));
check('API is GET-only', (await fetch(B + '/api/suggested-pillars', { method: 'POST' })).status === 405);
const abandoned = await mk(); await login(abandoned, 'drift@example.com'); await idea('Abandoned Wizard Idea');
await runWizard(abandoned, { stopAt: 3 });
const after = await (await fetch(B + '/api/suggested-pillars')).json();
check('an abandoned wizard (no submission) suggests nothing', !after.items.some((i) => i.idea === 'Abandoned Wizard Idea') && (await (await fetch(B + '/__db')).json()).discovery.some((d) => d.ai_mapping?.newIdeas?.includes('Abandoned Wizard Idea')));

// 8. someone else sees the same list; a failing API shows a calm message
await voices(q); await q.click('#acc-suggested .acc-head'); await settle(q);
check('other participant sees the same suggestions', (await q.locator('.sugg-row').count()) === 2);

check('no page errors', errs.length === 0, errs.join('|'));
console.log(`\n${pass}/${total} passed`); await b.close();
process.exit(pass === total ? 0 : 1);
