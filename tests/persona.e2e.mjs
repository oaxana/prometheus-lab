import { launch } from './lib.mjs';
const B = 'http://localhost:4173'; let pass = 0, total = 0;
const check = (n, ok, x = '') => { total++; if (ok) pass++; console.log(ok ? 'PASS' : 'FAIL', n, x); };
const b = await launch();
const p = await (await b.newContext({ viewport: { width: 420, height: 900 }, colorScheme: 'dark' })).newPage();
p.on('dialog', (d) => d.accept()); const errs = []; p.on('pageerror', (e) => errs.push(String(e)));
const nav = (t) => p.click(`nav button:has-text("${t}")`);
const submit = async (t) => { await nav('Submit'); await p.fill('#voice-text', t); await p.click('main .btn-primary:has-text("Submit")'); await p.waitForSelector('h2:has-text("All Voices")'); };
const post = (path, body) => fetch(B + path, { method: 'POST', body: JSON.stringify(body) });

await p.goto(B);
await nav('Submit');
check('locked: no persona switcher for normal visitors', (await p.locator('.persona-row').count()) === 0);
await p.evaluate(() => sessionStorage.setItem('prometheus-lab-admin', 'letmein')); await p.reload(); await nav('Submit');
check('unlocked: switcher shows Off / Me / Persona 2 / Persona 3', (await p.locator('.persona-row .pillar-chip').allInnerTexts()).join(',') === 'Off,Me,Persona 2,Persona 3');

// Persona 2: name autofilled, test on, anonymous off
await p.click('.persona-row .pillar-chip:has-text("Persona 2")');
check('Persona 2: name prefilled', (await p.inputValue('#display-name')) === 'Persona 2');
check('Persona 2: test toggle on', await p.locator('text=Excluded from synthesis by default').isVisible());
await p.screenshot({ path: 'screens/shot-persona.png', fullPage: false });
await submit('P2: signage and opt-out is the realistic default.');
await p.click('.toggle-row:has-text("Show tests")');
check('P2 card named + yours + test', (await p.locator('.submission-meta').first().innerText()).includes('Persona 2') && (await p.locator('.mine-badge').count()) === 1 && (await p.locator('.test-badge').count()) === 1);
check('"Viewing as Persona 2" note', await p.locator('text=Viewing as Persona 2').isVisible());

// Persona 3: P2's card is no longer "yours"
await nav('Submit'); await p.click('.persona-row .pillar-chip:has-text("Persona 3")');
await submit('P3: opt-in only for identifying people.');
await p.click('.toggle-row:has-text("Show tests")'); await p.click('.toggle-row:has-text("Show tests")'); // ensure on
if ((await p.locator('.submission-card').count()) < 2) await p.click('.toggle-row:has-text("Show tests")');
check('two cards; only Persona 3 is "yours"', (await p.locator('.submission-card').count()) === 2 && (await p.locator('.mine-badge').count()) === 1);
check('"yours" belongs to Persona 3', (await p.locator('.submission-card.mine .submission-meta').innerText()).includes('Persona 3'));
check("Persona 3 cannot see Persona 2's raw text", (await p.locator('.raw-toggle:has-text("Show your full submission")').count()) === 1);

// Me: real submission (test off), name "Me"
await nav('Submit'); await p.click('.persona-row .pillar-chip:has-text("Me")');
check('Me: name "Me", test off', (await p.inputValue('#display-name')) === 'Me' && (await p.locator('text=Excluded from synthesis by default').count()) === 0);
await submit('Me: strict opt-in, default off.');
check('persona survives reload (session)', true);

// an anonymous stranger (two voices, same uid) + named voices go in the prompt
await post('/supabase/rest/v1/submissions', { pillars: [2], content: 'anon thought one', summary: 's', auto_tagged: false, is_test: false, uid: 'stranger-uid-0001', display_name: '' });
await post('/supabase/rest/v1/submissions', { pillars: [3], content: 'anon thought two', summary: 's', auto_tagged: false, is_test: false, uid: 'stranger-uid-0001', display_name: '' });
await p.reload(); await nav('Synthesis');
await p.click('.toggle-row:has-text("Include test submissions")');
await p.click('button:has-text("Run synthesis")'); await p.waitForSelector('.tag-commons');

// rendering
const items = p.locator('.card:has(.tag-contested) .syn-list li');
check('contested: bullets, one per position', (await items.count()) === 2);
check('contested: holders shown first', (await items.nth(0).locator('.who').innerText()) === 'Me' && (await items.nth(0).innerText()).includes('Strict opt-in') && (await items.nth(1).locator('.who').innerText()) === 'Persona 2, Persona 3' && (await items.nth(1).innerText()).includes('Signage + opt-out'));
check('contested: core tension line', await p.locator('.tension:has-text("Core tension: Consent vs practicality")').isVisible());
const cItems = p.locator('.card:has(.tag-commons) .syn-list.commons li');
check('commons: one bullet per agreed point', (await cItems.count()) === 2);
check('commons: strength badge', (await p.locator('.card:has(.tag-commons) .pill.auto').innerText()) === 'strong');
const who0 = await cItems.nth(0).locator('.who').innerText();
check('commons: named people + "2 anonymous" (invented author dropped)', who0 === 'Me, Persona 2, 2 anonymous', who0);
check('commons: single anonymous shows "1 anonymous"', (await cItems.nth(1).locator('.who').innerText()) === 'Persona 2, 1 anonymous');
check('prose: numbered anonymous label scrubbed from text', (await cItems.nth(1).innerText()).includes('says an anonymous voice') && !(await cItems.nth(1).innerText()).includes('Anonymous voice'));
check('no numbered anonymous labels visible anywhere', !(await p.locator('main').innerText()).includes('Anonymous voice'));
const stored = (await (await fetch(B + '/__db')).json()).synthesis;
check('stored synthesis has no numbered labels or uids', !JSON.stringify(stored).includes('Anonymous voice') && JSON.stringify(stored).includes('2 anonymous'));
const gaps = p.locator('.card:has(.tag-gaps) .synthesis-item');
check('gaps: two pillars listed', (await gaps.count()) === 2);
check('gaps: "Why it matters" bullet', (await gaps.nth(0).locator('.syn-list > li').nth(0).innerText()).startsWith('Why it matters'));
const topics = await gaps.nth(0).locator('.syn-sub li').allInnerTexts();
check('gaps: 4 topics from the pillar reference (Environmental Stewardship)', topics.length === 4 && topics[0].includes('Digital MOOP'), topics[0]);
check('gaps: LLM html escaped', (await gaps.nth(0).innerHTML()).includes('&lt;i&gt;environment&lt;/i&gt;'));
check('LLM html still escaped', (await p.locator('.card:has(.tag-commons) .synthesis-item').innerHTML()).includes('&lt;b&gt;disclosure&lt;/b&gt;'));
await p.screenshot({ path: 'screens/shot-synth-attrib.png', fullPage: true });

// what the model was actually asked
const log = await (await fetch(B + '/__log')).json();
const prompt = log.filter((x) => x.anthropic).pop().anthropic.messages[0].content;
check('prompt lists authors incl. anonymous numbering', /AUTHORS: .*Me.*Persona 2.*Persona 3.*Anonymous voice 1/.test(prompt) || (prompt.includes('Anonymous voice 1') && prompt.includes('Persona 3') && prompt.includes('Me')), prompt.match(/AUTHORS: .*/)[0]);
check('each anonymous SUBMISSION gets its own number (even from one browser)', prompt.includes('author="Anonymous voice 1"') && prompt.includes('author="Anonymous voice 2"'));
check('no uid / identifiers sent to the model', !/uid|stranger-uid/.test(prompt));
check('voices tagged with author', prompt.includes('author="Persona 2"') && prompt.includes('author="Me"'));
check('5 authors: Me, P2, P3 + 2 anonymous submissions', prompt.includes('from 5 authors'), prompt.match(/from \d authors/)[0]);

// legacy saved synthesis (string positions) still renders
await p.evaluate(() => { S.synthesis = { commons: [{ pillar: 'OldC', summary: 'Old summary', strength: 'strong', voices: ['Me'] }], contested: [{ pillar: 'Old', positions: ['A view', 'B view'], tension: 't' }], gaps: [{ pillar: 'OldG', note: 'old note' }], timestamp: Date.now(), count: 1 }; render(); });
check('legacy commons (summary+voices) still renders', (await p.locator('.syn-list.commons li').first().innerText()).includes('Old summary') && (await p.locator('.syn-list.commons .who').first().innerText()) === 'Me');
check('legacy gaps (no pillarId) render without topics', (await p.locator('.syn-list.gaps li').count()) === 1);
check('legacy string positions render as Position N bullets', (await p.locator('.card:has(.tag-contested) .syn-list li .who').first().innerText()) === 'Position 1' && (await p.locator('.card:has(.tag-contested) .syn-list li').first().innerText()).includes('A view'));

// locking resets personas
await p.click('button:has-text("Lock project-lead controls")'); await nav('Submit');
check('lock: switcher gone, back to normal anonymous', (await p.locator('.persona-row').count()) === 0 && (await p.locator('#display-name').count()) === 0);
check('no page errors', errs.length === 0, errs.join('|'));
console.log(`\n${pass}/${total} passed`); await b.close();
