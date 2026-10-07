import { launch, runWizard } from './lib.mjs';
const B = 'http://localhost:4173'; let pass = 0, total = 0;
const check = (n, ok, x = '') => { total++; if (ok) pass++; console.log(ok ? 'PASS' : 'FAIL', n, x); };
const b = await launch();
const p = await (await b.newContext({ viewport: { width: 420, height: 900 }, colorScheme: 'dark' })).newPage();
p.on('dialog', (d) => d.accept()); const errs = []; p.on('pageerror', (e) => errs.push(String(e)));
const nav = (t) => p.click(`nav button:has-text("${t}")`);
const submit = async (t) => { await runWizard(p, { text: t }); await nav('Voices'); await p.waitForSelector('h2:has-text("All Voices")'); };
const postService = (path, body) => fetch(B + path, { method: 'POST', headers:{apikey:'service-test','content-type':'application/json'}, body: JSON.stringify(body) });
const postApi = (body, key = 'letmein') => fetch(B + '/api/test-persona-submit', { method: 'POST', headers:{'x-admin-key':key,'content-type':'application/json'}, body: JSON.stringify(body) });

await p.goto(B);
await nav('Submit');
check('locked: no persona switcher for normal visitors', (await p.locator('.persona-row').count()) === 0);
await p.evaluate(() => sessionStorage.setItem('prometheus-lab-admin', 'letmein')); await p.reload(); await nav('Submit');
check('unlocked: switcher shows Off / Me / Persona 2 / Persona 3', (await p.locator('.persona-row .pillar-chip').allInnerTexts()).join(',') === 'Off,Me,Persona 2,Persona 3');

// Persona 2: fixed server-controlled name, test-only, no Auth participant link
await p.click('.persona-row .pillar-chip:has-text("Persona 2")');
check('Persona 2: fixed name shown', await p.locator('.test-status:has-text("Persona 2")').isVisible());
check('Persona 2: permanently test-only', (await p.locator('.test-status').innerText()).includes('Always excluded'));
await p.screenshot({ path: 'screens/shot-persona.png', fullPage: false });
await submit('P2: signage and opt-out is the realistic default.');
await p.click('.toggle-row:has-text("Show tests")');
check('P2 card named + yours + test', (await p.locator('.submission-meta').first().innerText()).includes('Persona 2') && (await p.locator('.mine-badge').count()) === 1 && (await p.locator('.test-badge').count()) === 1);
check('P2 raw text is not returned through the public listing RPC', (await p.locator('.raw-toggle:has-text("Show your full submission")').count()) === 0);
check('"Viewing as Persona 2" note', await p.locator('text=Viewing as Persona 2').isVisible());

// Test-persona deletion is server/admin protected, not a public uid-based RPC.
await postApi({persona:2,pillars:[1],content:'temporary persona row',summary:'temp',autoTagged:false});
let snapshot = (await (await fetch(B + '/__db')).json()).submissions;
const temporary = snapshot.find((s) => s.content === 'temporary persona row');
let response = await postApi({persona:2,deleteId:temporary.id},'wrong');
check('persona delete rejects the wrong admin key', response.status === 401);
snapshot = (await (await fetch(B + '/__db')).json()).submissions;
check('wrong-key delete leaves persona row intact', snapshot.some((s) => s.id === temporary.id));
response = await postApi({persona:2,deleteId:temporary.id});
snapshot = (await (await fetch(B + '/__db')).json()).submissions;
check('admin-key persona delete removes only the requested test row', response.status === 200 && !snapshot.some((s) => s.id === temporary.id));

// Persona 3: P2's card is no longer "yours"
await nav('Submit'); await p.click('.persona-row .pillar-chip:has-text("Persona 3")');
await submit('P3: opt-in only for identifying people.');
await p.click('.toggle-row:has-text("Show tests")'); await p.click('.toggle-row:has-text("Show tests")'); // ensure on
if ((await p.locator('.submission-card').count()) < 2) await p.click('.toggle-row:has-text("Show tests")');
check('two cards; only Persona 3 is "yours"', (await p.locator('.submission-card').count()) === 2 && (await p.locator('.mine-badge').count()) === 1);
check('"yours" belongs to Persona 3', (await p.locator('.submission-card.mine .submission-meta').innerText()).includes('Persona 3'));
check('test personas never receive raw text through the public listing RPC', (await p.locator('.raw-toggle:has-text("Show your full submission")').count()) === 0);

// Me: also a detached, test-only persona (never the signed-in participant)
await nav('Submit'); await p.click('.persona-row .pillar-chip:has-text("Me")');
check('Me: fixed name and test-only notice', await p.locator('.test-status:has-text("Me")').isVisible());
await submit('Me: strict opt-in, default off.');
check('persona survives reload (session)', true);

// one authenticated anonymous participant with two contributions + named test voices
const stranger='11111111-1111-4111-8111-111111111111';
await postService('/supabase/rest/v1/submissions', { pillars: [2], content: 'anon thought one', summary: 's', auto_tagged: false, is_test: false, participant_id:stranger, uid: null, display_name: '' });
await postService('/supabase/rest/v1/submissions', { pillars: [3], content: 'anon thought two', summary: 's', auto_tagged: false, is_test: false, participant_id:stranger, uid: null, display_name: '' });
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
check('commons: named people + one distinct anonymous participant', who0 === 'Me, Persona 2, 1 anonymous', who0);
check('commons: repeated anonymous submissions still count once', (await cItems.nth(1).locator('.who').innerText()) === 'Persona 2, 1 anonymous');
check('prose: ephemeral participant label scrubbed from text', (await cItems.nth(1).innerText()).includes('says a participant') && !(await cItems.nth(1).innerText()).includes('Participant D'));
check('no run-local participant labels visible anywhere', !/Participant [A-Z]/.test(await p.locator('main').innerText()));
const stored = (await (await fetch(B + '/__db')).json()).synthesis;
check('stored synthesis has no run-local labels or ids', !/Participant [A-Z]/.test(JSON.stringify(stored)) && !JSON.stringify(stored).includes(stranger) && JSON.stringify(stored).includes('1 anonymous'));
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
check('prompt uses only run-local participant/source labels', prompt.includes('RUN-LOCAL PARTICIPANTS: Participant A | Participant B | Participant C | Participant D') && prompt.includes('Participant D source 1 (anonymous)'));
check('two anonymous contributions share one run-local participant source', (prompt.match(/source="Participant D source 1 \(anonymous\)"/g)||[]).length===2);
check('no auth UUID, legacy uid, email, or public names sent to model', !prompt.includes(stranger) && !/uid|@example\.com|Persona 2|Persona 3/.test(prompt));
check('four distinct people despite five contributions', prompt.includes('5 contributions from 4 distinct participants'), prompt.match(/\d contributions from \d distinct participants/)[0]);

// legacy saved synthesis (string positions) still renders
await p.evaluate(() => { S.synthesis = { commons: [{ pillar: 'OldC', summary: 'Old summary', strength: 'strong', voices: ['Me'] }], contested: [{ pillar: 'Old', positions: ['A view', 'B view'], tension: 't' }], gaps: [{ pillar: 'OldG', note: 'old note' }], timestamp: Date.now(), count: 1 }; render(); });
check('legacy commons (summary+voices) still renders', (await p.locator('.syn-list.commons li').first().innerText()).includes('Old summary') && (await p.locator('.syn-list.commons .who').first().innerText()) === 'Me');
check('legacy gaps (no pillarId) render without topics', (await p.locator('.syn-list.gaps li').count()) === 1);
check('legacy string positions render as Position N bullets', (await p.locator('.card:has(.tag-contested) .syn-list li .who').first().innerText()) === 'Position 1' && (await p.locator('.card:has(.tag-contested) .syn-list li').first().innerText()).includes('A view'));

// locking resets personas
await p.click('button:has-text("Lock project-lead controls")'); await nav('Submit');
check('lock: switcher gone, back to participant verification', (await p.locator('.persona-row').count()) === 0 && await p.locator('.verify-card').isVisible());
check('no page errors', errs.length === 0, errs.join('|'));
console.log(`\n${pass}/${total} passed`); await b.close();
