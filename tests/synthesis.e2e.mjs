import { launch, adminCookie } from './lib.mjs';
const B = 'http://localhost:4173'; let pass = 0, total = 0;
const check = (n, ok, x = '') => { total++; if (ok) pass++; console.log(ok ? 'PASS' : 'FAIL', n, x); };
const b = await launch();
const p = await (await b.newContext({ viewport: { width: 420, height: 900 }, colorScheme: 'dark' })).newPage();
p.on('dialog', (d) => d.accept()); const errs = []; p.on('pageerror', (e) => errs.push(String(e)));
const nav = (t) => p.click(`nav button:has-text("${t}")`);
const postService = (path, body) => fetch(B + path, { method: 'POST', headers:{apikey:'service-test','content-type':'application/json'}, body: JSON.stringify(body) });

// Five contributions from four people, inserted server-side: three named test voices (no Auth participant)
// and one authenticated anonymous participant with two contributions.
for (const [name, uid, content] of [['Persona 2', 'test-voice-2', 'P2: signage and opt-out is the realistic default.'], ['Persona 3', 'test-voice-3', 'P3: opt-in only for identifying people.'], ['Me', 'test-voice-me', 'Me: strict opt-in, default off.']]) {
  await postService('/supabase/rest/v1/submissions', { pillars: [1], content, summary: 's', auto_tagged: false, is_test: true, participant_id: null, uid, display_name: name });
}
const stranger='11111111-1111-4111-8111-111111111111';
await postService('/supabase/rest/v1/submissions', { pillars: [2], content: 'anon thought one', summary: 's', auto_tagged: false, is_test: false, participant_id:stranger, uid: null, display_name: '' });
await postService('/supabase/rest/v1/submissions', { pillars: [3], content: 'anon thought two', summary: 's', auto_tagged: false, is_test: false, participant_id:stranger, uid: null, display_name: '' });

// The project lead logs in on the Admin page and unlocks the tabs (no submission of their own)
await p.goto(B); await p.waitForSelector('.hero-cta');
await p.click('.admin-link'); await p.fill('#admin-password', 'letmein'); await p.click('.admin-login button');
await p.waitForSelector('.admin-switch'); await p.click('.admin-switch');
await nav('Synthesis');
await p.click('.toggle-row:has-text("Include test submissions")');
await p.click('button:has-text("Run synthesis")'); await p.waitForSelector('.syn-sec');

// rendering: stats banner, then three levels that all start collapsed
const settle = () => p.waitForTimeout(450);
const stats = (await p.locator('.syn-stat').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
check('stats banner: voices, pillars covered, common ground, contested, gaps', stats.join('|') === '4 Voices heard|2/12 Pillars covered|1 Common ground|1 Contested|2 Gaps', stats.join('|'));
check('three coloured section groups, all collapsed (level 1)', (await p.locator('.syn-sec').count()) === 3 && (await p.locator('.syn-shead[aria-expanded=true]').count()) === 0 && (await p.locator('#acc-body-syn-commons').evaluate((e) => e.getBoundingClientRect().height)) === 0);
const secColor = (k) => p.locator(`#acc-syn-${k} .syn-tag`).evaluate((e) => getComputedStyle(e).color);
check('section colours: green / amber / blue (dark theme)', (await secColor('commons')) === 'rgb(74, 186, 122)' && (await secColor('contested')) === 'rgb(232, 169, 72)' && (await secColor('gaps')) === 'rgb(107, 138, 237)');
await p.click('#acc-syn-commons .syn-shead'); await settle();
check('section opens to reveal pillar rows; the pillar detail is still collapsed (level 2)', (await p.locator('#acc-syn-commons .syn-pillar').count()) === 1 && (await p.locator('#acc-syn-commons-10 .syn-phead').getAttribute('aria-expanded')) === 'false' && (await p.locator('#acc-body-syn-commons-10').evaluate((e) => e.getBoundingClientRect().height)) === 0);
check('chevron turns when opened', (await p.locator('#acc-syn-commons .syn-shead .rot').evaluate((e) => getComputedStyle(e).transform)) !== 'none');
check('commons row: consensus bar 90% filled + pillar name + (3) participants pill', (await p.locator('#acc-syn-commons-10 .syn-meter i').evaluate((e) => e.style.width)) === '90%' && (await p.locator('#acc-syn-commons-10 .syn-pname').innerText()).includes('AI Presence, Identity & Immediacy') && (await p.locator('#acc-syn-commons-10 .sugg-count').innerText()) === '(3)');
await p.locator('#acc-syn-commons-10 .sugg-count').click();
check('tapping the pill lists participants: named + "Anonymous"', (await p.locator('#acc-syn-commons-10 .sugg-who').isVisible()) && (await p.locator('#acc-syn-commons-10 .sugg-who').innerText()) === 'Me, Persona 2, Anonymous');
await p.mouse.click(5, 5);
await p.click('#acc-syn-commons-10 .syn-phead'); await settle();
const cItems = p.locator('#acc-syn-commons-10 .syn-pts li');
check('detail (level 3): one bullet per agreed point with its holders', (await cItems.count()) === 2 && (await cItems.nth(0).innerText()).includes('— Me, Persona 2, 1 anonymous') && (await cItems.nth(1).innerText()).includes('— Persona 2, 1 anonymous'));
check('detail: key themes, quote and nuance', (await p.locator('#acc-syn-commons-10 .syn-theme').allInnerTexts()).join('|') === 'Disclosure first|No deepfakes' && (await p.locator('#acc-syn-commons-10 .syn-quote').innerText()).includes('AI must say what it is') && (await p.locator('#acc-syn-commons-10 .syn-note').innerText()).includes('Agreement is <i>strongest</i>'));
check('prose: ephemeral participant label scrubbed from text', (await cItems.nth(1).innerText()).includes('says a participant') && !(await cItems.nth(1).innerText()).includes('Participant D'));
check('LLM html still escaped (points, quotes, nuance)', (await p.locator('#acc-syn-commons-10 .syn-detail').innerHTML()).includes('&lt;b&gt;disclosure&lt;/b&gt;') && (await p.locator('#acc-syn-commons-10 .syn-detail').innerHTML()).includes('&lt;u&gt;Always&lt;/u&gt;') && (await p.locator('#acc-syn-commons-10 .syn-detail').innerHTML()).includes('&lt;i&gt;strongest&lt;/i&gt;'));
// contested: spectrum with positioned, named dots
await p.click('#acc-syn-contested .syn-shead'); await settle(); await p.click('#acc-syn-contested-1 .syn-phead'); await settle();
check('contested row: bar shows the biggest camp (2 of 3 = 67%), pill (3)', (await p.locator('#acc-syn-contested-1 .syn-meter i').evaluate((e) => e.style.width)) === '67%' && (await p.locator('#acc-syn-contested-1 .sugg-count').innerText()) === '(3)');
check('spectrum: poles + one dot per participant', (await p.locator('#acc-syn-contested-1 .spec-poles span').allInnerTexts()).join('|') === 'Strict opt-in|Signage + opt-out' && (await p.locator('#acc-syn-contested-1 .dot').count()) === 3);
const xs = await p.locator('#acc-syn-contested-1 .dot').evaluateAll((els) => els.map((e) => parseFloat(e.style.left)));
check('spectrum: Me sits near the left pole, Persona 2 + 3 near the right', xs[0] < 20 && xs[1] > 70 && xs[2] > 70 && xs[1] !== xs[2], xs.join(','));
const track = await p.locator('#acc-syn-contested-1 .spec-track').evaluate((e) => getComputedStyle(e).backgroundImage);
check('spectrum track is a horizontal gradient', track.startsWith('linear-gradient(90deg') || track.includes('90deg'), track.slice(0, 40));
await p.locator('#acc-syn-contested-1 .dot').first().hover();
check('dot hover shows the participant name', (await p.locator('#acc-syn-contested-1 .dot').first().locator('.sugg-who').isVisible()) && (await p.locator('#acc-syn-contested-1 .dot').first().locator('.sugg-who').innerText()) === 'Me');
await p.mouse.move(5, 5);
await p.locator('#acc-syn-contested-1 .dot').nth(2).click();
check('tapping a dot reveals its name too', (await p.locator('#acc-syn-contested-1 .dot').nth(2).locator('.sugg-who').innerText()) === 'Persona 3' && (await p.locator('.who-host.open').count()) === 1);
await p.mouse.click(5, 5);
const items = p.locator('#acc-syn-contested-1 .syn-pts li');
check('contested positions listed with holders', (await items.count()) === 2 && (await items.nth(0).innerText()).includes('Strict opt-in') && (await items.nth(0).innerText()).includes('— Me') && (await items.nth(1).innerText()).includes('— Persona 2, Persona 3'));
check('contested: core tension shown', (await p.locator('#acc-syn-contested-1 .syn-note').innerText()) === 'Consent vs practicality');
// gaps: arrow bullets
await p.click('#acc-syn-gaps .syn-shead'); await settle(); await p.click('#acc-syn-gaps-6 .syn-phead'); await p.click('#acc-syn-gaps-11 .syn-phead'); await settle();
check('gaps: two simple rows (no bar, no participant pill)', (await p.locator('#acc-syn-gaps .syn-pillar').count()) === 2 && (await p.locator('#acc-syn-gaps .syn-meter, #acc-syn-gaps .sugg-count').count()) === 0);
const arrows = await p.locator('#acc-syn-gaps-6 .syn-arrows li').allInnerTexts();
check('gaps: arrow-prefixed suggestions, html escaped', arrows.length === 2 && (await p.locator('#acc-syn-gaps-6 .syn-arrows li').first().evaluate((e) => getComputedStyle(e, '::before').content)) === '"→"' && (await p.locator('#acc-syn-gaps-6 .syn-detail').innerHTML()).includes('&lt;b&gt;MOOP&lt;/b&gt;') && (await p.locator('#acc-syn-gaps-6 .syn-detail').innerHTML()).includes('&lt;i&gt;environment&lt;/i&gt;'), arrows.join('|'));
check('gaps: no model suggestions -> falls back to the pillar’s own topics', (await p.locator('#acc-syn-gaps-11 .syn-arrows li').count()) === 4 && (await p.locator('#acc-syn-gaps-11 .syn-arrows li').first().innerText()).includes('Designing for playa first'));
check('no run-local participant labels visible anywhere', !/Participant [A-Z]/.test(await p.locator('main').innerText()));
await p.evaluate(() => render());
check('open/closed choices survive a redraw', (await p.locator('#acc-syn-commons-10 .syn-phead').getAttribute('aria-expanded')) === 'true' && (await p.locator('#acc-syn-gaps .syn-shead').getAttribute('aria-expanded')) === 'true');
await p.click('#acc-syn-commons .syn-shead'); await settle();
check('collapsing a section keeps what was open inside it', (await p.locator('#acc-body-syn-commons').evaluate((e) => e.getBoundingClientRect().height)) === 0 && (await p.locator('#acc-syn-commons-10 .syn-phead').getAttribute('aria-expanded')) === 'true');
await p.click('#acc-syn-commons .syn-shead'); await settle();
check('phone width: no sideways scrolling', await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
const fam = await p.evaluate(() => [getComputedStyle(document.querySelector('.syn')).fontFamily, getComputedStyle(document.querySelector('.syn-num')).fontFamily, getComputedStyle(document.querySelector('.syn-stat')).backgroundColor]);
check('fonts: DM Sans body, Space Mono labels; dark surface #1a1a1f', fam[0].includes('DM Sans') && fam[1].includes('Space Mono') && fam[2] === 'rgb(26, 26, 31)', fam.join(' / '));
const stored0 = (await (await fetch(B + '/__db')).json()).synthesis;
check('stored synthesis: per-pillar participants are names or "Anonymous" only; contested consensus computed server-side', JSON.stringify(stored0.commons[0].participants) === '["Me","Persona 2","Anonymous"]' && stored0.contested[0].participants.length === 3 && stored0.contested[0].participants.every((n) => ['Me', 'Persona 2', 'Persona 3', 'Anonymous'].includes(n)) && stored0.contested[0].consensus === 67 && !JSON.stringify(stored0).includes(stranger));
await p.emulateMedia({ colorScheme: 'light' });
const light = await p.evaluate(() => [getComputedStyle(document.querySelector('.syn-stat')).backgroundColor, getComputedStyle(document.querySelector('.syn-tag')).color, getComputedStyle(document.querySelector('.syn-stat')).borderTopColor]);
check('light mode: white surface and darker section colours', light[0] === 'rgb(255, 255, 255)' && light[1] !== 'rgb(74, 186, 122)', light.join(' / '));
await p.emulateMedia({ colorScheme: 'dark' });
await p.screenshot({ path: 'screens/shot-synth-attrib.png', fullPage: true });

// what the model was actually asked
const log = await (await fetch(B + '/__log')).json();
const prompt = log.filter((x) => x.anthropic).pop().anthropic.messages[0].content;
check('prompt uses only run-local participant/source labels', prompt.includes('RUN-LOCAL PARTICIPANTS: Participant A | Participant B | Participant C | Participant D') && prompt.includes('Participant D source 1 (anonymous)'));
check('two anonymous contributions share one run-local participant source', (prompt.match(/source="Participant D source 1 \(anonymous\)"/g)||[]).length===2);
check('no auth UUID, legacy uid, email, or public names sent to model', !prompt.includes(stranger) && !/uid|@example\.com|Persona 2|Persona 3/.test(prompt));
check('four distinct people despite five contributions', prompt.includes('5 contributions from 4 distinct participants'), prompt.match(/\d contributions from \d distinct participants/)[0]);

// sloppy model output is repaired, not trusted: numbers clamped, missing fields tolerated
await fetch(B + '/__synth?m=sparse');
const sparse = await (await fetch(B + '/api/synthesize', { method: 'POST', headers: { cookie: await adminCookie(B), 'content-type': 'application/json' }, body: JSON.stringify({ includeTests: true }) })).json();
await fetch(B + '/__synth?m=full');
check('sparse output: consensus clamped to 0-100, or taken from the strength label when unusable', sparse.commons[0].consensus === 100 && sparse.commons[1].consensus === 0 && sparse.commons[1].strength === 'emerging');
check('sparse output: themes/quotes/suggestions capped and trimmed', sparse.commons[1].themes[0].length === 60 && sparse.commons[1].quotes.length === 2 && sparse.gaps[0].suggestions.length === 4);
check('sparse output: half-empty spectrum is dropped, position values clamped', sparse.contested[0].spectrum === null && sparse.contested[0].positions.map((x) => x.value).join() === '0,100');
check('sparse output: pillar participants are still names/Anonymous only', sparse.commons[0].participants.length === 1 && sparse.contested[0].participants.length === 2 && !JSON.stringify(sparse).includes(stranger));

// legacy saved synthesis (older shapes, no consensus/participants/spectrum) still renders
await p.evaluate(() => { S.acc = {}; S.synthesis = { commons: [{ pillar: 'OldC', summary: 'Old summary', strength: 'strong', voices: ['Me', '2 anonymous'] }], contested: [{ pillar: 'Old', positions: ['A view', 'B view'], tension: 't' }], gaps: [{ pillar: 'OldG', note: 'old note' }], timestamp: Date.now(), count: 1 }; render(); });
await p.click('#acc-syn-commons .syn-shead'); await p.click('#acc-syn-contested .syn-shead'); await p.click('#acc-syn-gaps .syn-shead'); await settle();
await p.click('#acc-syn-commons-OldC .syn-phead'); await p.click('#acc-syn-contested-Old .syn-phead'); await p.click('#acc-syn-gaps-OldG .syn-phead'); await settle();
check('legacy commons: bar from the strength label, pill counts people from the old voices list, summary shown', (await p.locator('#acc-syn-commons-OldC .syn-meter i').evaluate((e) => e.style.width)) === '85%' && (await p.locator('#acc-syn-commons-OldC .sugg-count').innerText()) === '(3)' && (await p.locator('#acc-syn-commons-OldC .syn-pts li').first().innerText()).includes('Old summary'));
check('legacy gaps (no pillarId, no suggestions) show just the note', (await p.locator('#acc-syn-gaps-OldG .syn-arrows').count()) === 0 && (await p.locator('#acc-syn-gaps-OldG .syn-note').innerText()) === 'old note');
check('legacy string positions render as Position N and there is no spectrum', (await p.locator('#acc-syn-contested-Old .syn-pts li .syn-by').first().innerText()) === '— Position 1' && (await p.locator('#acc-syn-contested-Old .syn-pts li').first().innerText()).includes('A view') && (await p.locator('#acc-syn-contested-Old .spec-track').count()) === 0);

// test personas are gone
check('no "Testing as" persona switcher or persona code left', (await p.locator('.persona-row').count()) === 0 && (await p.evaluate(() => typeof setPersona === 'undefined' && typeof PERSONAS === 'undefined')));
check('no page errors', errs.length === 0, errs.join('|'));
console.log(`\n${pass}/${total} passed`); await b.close();
