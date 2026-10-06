import { launch } from './lib.mjs';


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
const uid1 = await page.evaluate(() => localStorage.getItem('prometheus-lab-uid'));
check('anonymous uid created in localStorage', !!uid1 && uid1.length >= 8, uid1);
await page.screenshot({ path: SHOTS + 'screens/shot-home.png' });

// Pillars tab
await page.click('nav button:has-text("Pillars")');
await page.click('button:has-text("Expand all")');
check('pillars expand all', (await page.locator('.pillar-ref-body.open').count()) === 12);
await page.screenshot({ path: SHOTS + 'screens/shot-pillars.png', fullPage: false });

// Submit tab: typed text must survive toggling anonymous + a background refresh
await page.click('nav button:has-text("Submit")');
await page.fill('#voice-text', 'AI should always disclose itself on playa.');
await page.click('.toggle-row:has-text("Anonymous")');
await page.fill('#display-name', 'Ember "<b>x</b>"');
await page.click('.toggle-row:has-text("Test submission")');
await page.click('.toggle-row:has-text("Test submission")');
check('typed text survives re-render', (await page.inputValue('#voice-text')).startsWith('AI should always'));
check('display name survives + quotes escaped', (await page.inputValue('#display-name')) === 'Ember "<b>x</b>"');
await page.screenshot({ path: SHOTS + 'screens/shot-submit.png', fullPage: true });

// Attach a text file via the file input
await page.setInputFiles('#drop-zone input[type=file]', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Data must be deleted after the burn.') });
await page.waitForSelector('.file-preview');
check('txt file attached', (await page.locator('.file-preview .name').innerText()) === 'notes.txt');

// Attach an image (tiny PNG) — should be re-encoded to JPEG client side
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
await page.setInputFiles('#drop-zone input[type=file]', { name: 'pic.png', mimeType: 'image/png', buffer: png });
await page.waitForFunction(() => document.querySelectorAll('.file-preview').length === 2);
check('image attached', true);

await page.click('main .btn-primary:has-text("Submit")');
await page.waitForSelector('.submission-card');
check('lands on Voices after submit', await page.locator('h2:has-text("All Voices")').isVisible());
check('card shows AI summary, not raw text', (await page.locator('.summary-text').first().innerText()) === 'A short summary.');
check('auto-tagged badge + pillar pills (1 and 3)', (await page.locator('.pill.auto').count()) === 2);
check('"yours" badge', await page.locator('.mine-badge').isVisible());
check('name escaped, not injected', (await page.locator('.submission-meta').first().innerText()).includes('Ember "<b>x</b>"'));
// attachment payload that reached the server
const log = await (await fetch(B + '/__log')).json();
const call = log.filter((x) => x.anthropic).pop().anthropic;
const kinds = call.messages[0].content.map((c) => c.type);
check('image sent to Claude as image block (jpeg)', kinds[0] === 'image' && call.messages[0].content[0].source.media_type === 'image/jpeg', kinds.join(','));
check('file text included in prompt', call.messages[0].content.at(-1).text.includes('Data must be deleted'));

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

// Test submission (no pillars chosen -> fake AI), then show/hide tests
await page.click('nav button:has-text("Submit")');
await page.fill('#voice-text', 'just testing');
await page.click('.pillar-chip >> nth=4');
await page.click('.toggle-row:has-text("Test submission")');
await page.click('main .btn-primary:has-text("Submit")');
await page.waitForSelector('.submission-card');
await page.click('.toggle-row:has-text("Show tests")');
check('test card appears when "Show tests" on', (await page.locator('.test-card').count()) === 1);
check('user-selected pillar kept & not auto-tagged', (await page.locator('.test-card .pill').count()) === 1 && (await page.locator('.test-card .pill.auto').count()) === 0);

// Synthesis: locked first
await page.click('nav button:has-text("Synthesis")');
check('locked: no run button', (await page.locator('button:has-text("Run synthesis")').count()) === 0);
check('locked: lead-only message', await page.locator('text=Only the project lead can trigger synthesis.').isVisible());
await page.click('button:has-text("Project lead? Unlock")');
await page.waitForSelector('button:has-text("Run synthesis")');
check('unlocked: run button shows 1 voice (tests excluded)', (await page.locator('button:has-text("Run synthesis")').innerText()).includes('1 voices'));
await page.click('.toggle-row:has-text("Include test submissions")');
check('include-tests updates count', (await page.locator('button:has-text("Run synthesis")').innerText()).includes('2 voices'));
await page.click('.toggle-row:has-text("Include test submissions")');
await page.click('button:has-text("Run synthesis")');
await page.waitForSelector('.tag-commons');
check('commons/contested/gaps cards rendered', (await page.locator('.card .section-tag').count()) === 3);
check('LLM html is escaped', (await page.locator('.synthesis-item').first().innerHTML()).includes('&lt;b&gt;disclosure&lt;/b&gt;'));
check('last-run line', (await page.locator('text=/Last run:.*1 voices.*tests excluded/').count()) === 1);
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

check('no console/page errors', errors.length === 0, errors.join(' | '));
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
await browser.close();
