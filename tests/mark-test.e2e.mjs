import { launch } from './lib.mjs';
const B = 'http://localhost:4173'; let pass = 0, total = 0;
const check = (n, ok, x = '') => { total++; if (ok) pass++; console.log(ok ? 'PASS' : 'FAIL', n, x); };
const b = await launch();
const p = await (await b.newContext({ viewport: { width: 420, height: 900 }, colorScheme: 'dark' })).newPage();
p.on('dialog', (d) => d.accept()); const errs = []; p.on('pageerror', (e) => errs.push(String(e)));
const submit = async (t) => { await p.click('nav button:has-text("Submit")'); await p.fill('#voice-text', t); await p.click('main .btn-primary:has-text("Submit")'); await p.waitForSelector('.submission-card'); };
await p.goto(B); await submit('voice A'); await submit('voice B');
const heading = async () => (await p.locator('h2').first().innerText());
check('starts with 2 real voices', (await heading()).includes('(2)'));
check('cards offer "Mark as test"', (await p.locator('button:has-text("Mark as test")').count()) === 2);
await p.locator('button:has-text("Mark as test")').first().click();
await p.waitForFunction(() => document.querySelectorAll('.submission-card').length === 1);
check('marked card leaves the list (tests hidden)', true);
check('heading shows 1 real + 1 test', (await heading()).includes('(1 + 1 test)'));
check('toast explains', await p.locator('.toast:has-text("left out of synthesis")').isVisible());
await p.click('.toggle-row:has-text("Show tests")');
check('card visible again with test badge + "Unmark test"', (await p.locator('.test-card .test-badge').count()) === 1 && (await p.locator('button:has-text("Unmark test")').count()) === 1);
await p.screenshot({ path: 'screens/shot-testflag.png', fullPage: true });
// synthesis tab: real count excludes it, include-tests toggle brings it back
await p.click('nav button:has-text("Synthesis")'); await p.click('button:has-text("Project lead? Unlock")'); // dialog auto-accepts with empty value
p.removeAllListeners('dialog'); 
const sess = await p.evaluate(() => { sessionStorage.setItem('prometheus-lab-admin', 'x'); });
await p.reload(); await p.click('nav button:has-text("Synthesis")');
check('synthesis counts 1 voice (test excluded)', (await p.locator('button:has-text("Run synthesis")').innerText()).includes('1 voices'));
await p.click('.toggle-row:has-text("Include test submissions")');
check('include-tests brings it back (2)', (await p.locator('button:has-text("Run synthesis")').innerText()).includes('2 voices'));
// unmark it again
p.on('dialog', (d) => d.accept());
await p.click('nav button:has-text("Voices")'); await p.click('.toggle-row:has-text("Show tests")');
await p.locator('button:has-text("Unmark test")').click();
await p.waitForFunction(() => !document.querySelector('.test-card'));
check('unmarked: back to 2 real voices', (await heading()).includes('(2)'));
check('no page errors', errs.length === 0, errs.join('|'));
console.log(`\n${pass}/${total} passed`); await b.close();
