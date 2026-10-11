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
await p.click('button:has-text("Create New Synthesis")'); await p.waitForSelector('.syn-sec');

// rendering: stats banner, then three levels that all start collapsed
const settle = () => p.waitForTimeout(450);
const stats = (await p.locator('.syn-stat').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
check('stats banner: voices, pillars covered, common ground, contested, gaps', stats.join('|') === 'Voices heard 4|Pillars covered 2 / 8|Common ground 1|Contested 1|Gaps 2', stats.join('|'));
check('Home "Pillars covered" uses the same number as the Synthesis tab', (await (await fetch(B + '/api/metrics')).json()).pillarsCovered === 2);
check('three coloured section groups, all collapsed (level 1)', (await p.locator('.syn-sec').count()) === 3 && (await p.locator('.syn-shead[aria-expanded=true]').count()) === 0 && (await p.locator('#acc-body-syn-commons').evaluate((e) => e.getBoundingClientRect().height)) === 0);
const secColor = (k) => p.locator(`#acc-syn-${k} .syn-tag`).evaluate((e) => getComputedStyle(e).color);
check('section colours: green / amber / blue (dark theme)', (await secColor('commons')) === 'rgb(74, 186, 122)' && (await secColor('contested')) === 'rgb(232, 169, 72)' && (await secColor('gaps')) === 'rgb(107, 138, 237)');
await p.click('#acc-syn-commons .syn-shead'); await settle();
check('section opens to reveal pillar rows; the pillar detail is still collapsed (level 2)', (await p.locator('#acc-syn-commons .syn-pillar').count()) === 1 && (await p.locator('#acc-syn-commons-8 .syn-phead').getAttribute('aria-expanded')) === 'false' && (await p.locator('#acc-body-syn-commons-8').evaluate((e) => e.getBoundingClientRect().height)) === 0);
check('chevron turns when opened', (await p.locator('#acc-syn-commons .syn-shead .rot').evaluate((e) => getComputedStyle(e).transform)) !== 'none');
check('commons row: consensus bar 90% filled + pillar name + (3) participants pill', (await p.locator('#acc-syn-commons-8 .syn-meter i').evaluate((e) => e.style.width)) === '90%' && (await p.locator('#acc-syn-commons-8 .syn-pname').innerText()).includes('Governance & Accountability') && (await p.locator('#acc-syn-commons-8 .sugg-count').innerText()) === '(3)');
await p.locator('#acc-syn-commons-8 .sugg-count').click();
check('tapping the pill lists participants: named + "Anonymous"', (await p.locator('#acc-syn-commons-8 .sugg-who').isVisible()) && (await p.locator('#acc-syn-commons-8 .sugg-who').innerText()) === 'Me, Persona 2, Anonymous');
await p.mouse.click(5, 5);
await p.click('#acc-syn-commons-8 .syn-phead'); await settle();
const cItems = p.locator('#acc-syn-commons-8 .syn-pts li');
check('detail (level 3): one bullet per agreed point with its holders', (await cItems.count()) === 2 && (await cItems.nth(0).innerText()).includes('— Me, Persona 2, 1 anonymous') && (await cItems.nth(1).innerText()).includes('— Persona 2, 1 anonymous'));
check('detail: key themes, quote and nuance', (await p.locator('#acc-syn-commons-8 .syn-theme').allInnerTexts()).join('|') === 'Disclosure first|No deepfakes' && (await p.locator('#acc-syn-commons-8 .syn-quote').innerText()).includes('AI must say what it is') && (await p.locator('#acc-syn-commons-8 .syn-note').innerText()).includes('Agreement is <i>strongest</i>'));
check('prose: ephemeral participant label scrubbed from text', (await cItems.nth(1).innerText()).includes('says a participant') && !(await cItems.nth(1).innerText()).includes('Participant D'));
check('LLM html still escaped (points, quotes, nuance)', (await p.locator('#acc-syn-commons-8 .syn-detail').innerHTML()).includes('&lt;b&gt;disclosure&lt;/b&gt;') && (await p.locator('#acc-syn-commons-8 .syn-detail').innerHTML()).includes('&lt;u&gt;Always&lt;/u&gt;') && (await p.locator('#acc-syn-commons-8 .syn-detail').innerHTML()).includes('&lt;i&gt;strongest&lt;/i&gt;'));
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
await p.click('#acc-syn-gaps .syn-shead'); await settle(); await p.click('#acc-syn-gaps-7 .syn-phead'); await p.click('#acc-syn-gaps-2 .syn-phead'); await settle();
check('gaps: two simple rows (no bar, no participant pill)', (await p.locator('#acc-syn-gaps .syn-pillar').count()) === 2 && (await p.locator('#acc-syn-gaps .syn-meter, #acc-syn-gaps .sugg-count').count()) === 0);
const arrows = await p.locator('#acc-syn-gaps-7 .syn-arrows li').allInnerTexts();
check('gaps: arrow-prefixed suggestions, html escaped', arrows.length === 2 && (await p.locator('#acc-syn-gaps-7 .syn-arrows li').first().evaluate((e) => getComputedStyle(e, '::before').content)) === '"→"' && (await p.locator('#acc-syn-gaps-7 .syn-detail').innerHTML()).includes('&lt;b&gt;MOOP&lt;/b&gt;') && (await p.locator('#acc-syn-gaps-7 .syn-detail').innerHTML()).includes('&lt;i&gt;environment&lt;/i&gt;'), arrows.join('|'));
check('gaps: no model suggestions -> falls back to the pillar’s own topics', (await p.locator('#acc-syn-gaps-2 .syn-arrows li').count()) === 4 && (await p.locator('#acc-syn-gaps-2 .syn-arrows li').first().innerText()).includes('When should AI advise'));
check('no run-local participant labels visible anywhere', !/Participant [A-Z]/.test(await p.locator('main').innerText()));
await p.evaluate(() => render());
check('open/closed choices survive a redraw', (await p.locator('#acc-syn-commons-8 .syn-phead').getAttribute('aria-expanded')) === 'true' && (await p.locator('#acc-syn-gaps .syn-shead').getAttribute('aria-expanded')) === 'true');
await p.click('#acc-syn-commons .syn-shead'); await settle();
check('collapsing a section keeps what was open inside it', (await p.locator('#acc-body-syn-commons').evaluate((e) => e.getBoundingClientRect().height)) === 0 && (await p.locator('#acc-syn-commons-8 .syn-phead').getAttribute('aria-expanded')) === 'true');
await p.click('#acc-syn-commons .syn-shead'); await settle();
check('phone width: no sideways scrolling', await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
const fam = await p.evaluate(() => [getComputedStyle(document.querySelector('.syn')).fontFamily, getComputedStyle(document.querySelector('.syn-tag')).fontFamily, getComputedStyle(document.querySelector('.syn-stat')).backgroundColor]);
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
const prompt = log.filter((x) => x.anthropic?.output_config?.format?.schema?.properties?.commons).pop().anthropic.messages[0].content;
check('prompt uses only run-local participant/source labels', prompt.includes('RUN-LOCAL PARTICIPANTS: Participant A | Participant B | Participant C | Participant D') && prompt.includes('Participant D source 1 (anonymous)'));
check('two anonymous contributions share one run-local participant source', (prompt.match(/source="Participant D source 1 \(anonymous\)"/g)||[]).length===2);
check('no auth UUID, legacy uid, email, or public names sent to model', !prompt.includes(stranger) && !/uid|@example\.com|Persona 2|Persona 3/.test(prompt));
check('four distinct people despite five contributions', prompt.includes('5 contributions from 4 distinct participants'), prompt.match(/\d contributions from \d distinct participants/)[0]);

// ---------------- version history
const llmCalls = async () => (await (await fetch(B + "/__log")).json()).filter((x) => x.anthropic?.output_config?.format?.schema?.properties?.commons).length;   // synthesis calls only (not fact-checks)
const versions = async () => (await (await fetch(B + '/__db')).json()).synthesisVersions;
const runApi = async (body = { includeTests: true }) => (await fetch(B + '/api/synthesize', { method: 'POST', headers: { cookie: await adminCookie(B), 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
const statusApi = async (q = '?includeTests=1') => (await fetch(B + '/api/synthesize' + q)).json();
const meta = async () => (await p.locator('.syn-meta').innerText()).replace(/\s+/g, ' ');
check('snapshot header: title, subtitle, then date · voices · contributions on one line', (await p.locator('h2').innerText()) === 'Collective Synthesis' && (await p.locator('.syn-intro').innerText()).toLowerCase() === 'ai analysis of all voices' && /^[A-Z][a-z]+ \d{1,2}, \d{4} \/ 4 voices \/ 5 contributions$/.test(await meta()), await meta());
await p.waitForSelector('.syn-status');
check('everything included -> "Current through all submitted contributions."', (await p.locator('.syn-status').innerText()).replace(/\s+/g, ' ').trim() === 'Current through all submitted contributions.');
check('admin: no Create button when nothing is new', (await p.locator('button:has-text("Create New Synthesis")').count()) === 0 && (await p.locator('.syn-run-note').count()) === 0);
check('one version -> picker already shows it as the latest', (await p.locator('#syn-version option').count()) === 1 && /^Version 1 · [A-Z][a-z]{2} \d{1,2} \(latest\)$/.test(await p.locator('#syn-version option').first().innerText()));
const v1 = (await versions())[0];
check('v1 stored with exact provenance: 5 contribution ids, 4 voice keys, 5 sources', v1.version === 1 && v1.provenance === 'exact' && v1.submission_ids.length === 5 && v1.voice_keys.length === 4 && v1.contribution_count === 5 && v1.voice_count === 4 && v1.source_count === 5);
const callsBefore = await llmCalls();
const again = await runApi();
check('no-change rerun returns the latest version without calling the model', again.unchanged === true && again.version === 1 && (await llmCalls()) === callsBefore && (await versions()).length === 1);
check('no-change rerun returns the stored content', JSON.stringify(again.commons) === JSON.stringify(v1.commons) && again.count === 4 && again.submissionCount === 5);
const st0 = await statusApi();
check('status API: integers only, nothing pending', st0.latestVersion === 1 && st0.pending.contributions === 0 && st0.pending.changed === false && st0.eligible.contributions === 5 && st0.eligible.voices === 4 && !JSON.stringify(st0).includes(stranger) && !/[0-9a-f]{8}-[0-9a-f]{4}/.test(JSON.stringify(st0)));
check('status API without tests: the 3 test rows count as removed from v1', (await statusApi('')).pending.removed === 3);
const browserRead = await fetch(B + '/supabase/rest/v1/synthesis_versions?select=version,submission_ids', { headers: { apikey: 'anon-test' } });
check('browser key cannot read the provenance columns', browserRead.status === 401);

// the pillar list changed since the latest version (it names a pillar from the original 12): a new version is allowed
const keepName = (await versions())[0].commons[0].pillar;
await fetch(B + '/__pillarname?v=' + encodeURIComponent('AI Presence, Identity & Immediacy'));
const stP = await statusApi();
check('status API: an old pillar name in the latest version means "pillars changed", with no new contributions', stP.pending.pillarsChanged === true && stP.pending.changed === true && stP.pending.contributions === 0);
await p.evaluate(() => { S.synStatusKey = ''; render(); }); await p.waitForSelector('.syn-status.pending');
check('pillars-changed line shown, and the admin can create a new version', (await p.locator('.syn-status').innerText()).includes('The pillars have changed') && (await p.locator('button:has-text("Create New Synthesis")').count()) === 1);
await fetch(B + '/__pillarname?v=' + encodeURIComponent(keepName));
check('back to the current pillar name: nothing pending again', (await statusApi()).pending.changed === false);
await p.evaluate(() => { S.synStatusKey = ''; render(); }); await p.waitForSelector('.syn-status:not(.pending)');

// new material: one more from the existing anonymous participant, one from a brand-new person
const newcomer = '22222222-2222-4222-8222-222222222222';
await postService('/supabase/rest/v1/submissions', { pillars: [2], content: 'anon thought three', summary: 's', auto_tagged: false, is_test: false, participant_id: stranger, uid: null, display_name: '' });
await postService('/supabase/rest/v1/submissions', { pillars: [4], content: 'newcomer thought', summary: 's', auto_tagged: false, is_test: false, participant_id: newcomer, uid: null, display_name: '' });
const st1 = await statusApi();
check('status API: 2 new contributions from 2 voices, 1 of them new', st1.pending.contributions === 2 && st1.pending.voices === 2 && st1.pending.newVoices === 1 && st1.pending.changed === true);
await p.evaluate(() => refresh()); await p.waitForSelector('.syn-status.pending');
check('pending line shown to everyone', (await p.locator('.syn-status').innerText()).replace(/\s+/g, ' ').trim() === '2 new contributions from 2 voices are waiting for the next synthesis.');
check('admin: Create New Synthesis appears once there is new material', (await p.locator('button:has-text("Create New Synthesis")').count()) === 1 && (await p.locator('.syn-run-note').count()) === 0);

// sloppy model output is repaired, not trusted: numbers clamped, missing fields tolerated (this run also creates v2)
await fetch(B + '/__synth?m=sparse');
const sparse = await runApi();
await fetch(B + '/__synth?m=full');
const all = await versions();
check('second run with new material creates v2 from ALL 7 contributions (not from v1)', sparse.version === 2 && sparse.unchanged === false && all.length === 2 && all[1].submission_ids.length === 7 && all[1].voice_keys.length === 5 && all[1].voice_count === 5 && (await llmCalls()) === callsBefore + 1);
check('v1 is untouched by the second run', JSON.stringify(all[0]) === JSON.stringify(v1));
const lastPrompt = (await (await fetch(B + "/__log")).json()).filter((x) => x.anthropic?.output_config?.format?.schema?.properties?.commons).pop().anthropic.messages[0].content;
check('v2 prompt carries the underlying contributions, not the previous synthesis', lastPrompt.includes('7 contributions from 5 distinct participants') && lastPrompt.includes('newcomer thought') && !lastPrompt.includes('Consent vs practicality'));
check('old single-row table mirrors the latest version', (await (await fetch(B + '/__db')).json()).synthesis.count === 5);
const dupe = await fetch(B + '/supabase/rest/v1/synthesis_versions', { method: 'POST', headers: { apikey: 'service-test', 'content-type': 'application/json' }, body: JSON.stringify({ version: 2 }) });
check('a second version 2 is refused (overlapping runs cannot overwrite)', dupe.status === 409);

// browse: latest shown by default, older version shown exactly as stored, nothing regenerated
await p.evaluate(() => refresh()); await p.waitForSelector('#syn-version');
check('picker lists both versions, newest first, latest selected', (await p.locator('#syn-version option').count()) === 2 && /^Version 2 · [A-Z][a-z]{2} \d{1,2} \(latest\)$/.test(await p.locator('#syn-version option').first().innerText()) && /^Version 1 · /.test(await p.locator('#syn-version option').nth(1).innerText()) && (await p.locator('#syn-version').inputValue()) === '2' && (await p.evaluate(() => { const r = document.getElementById('syn-version').getBoundingClientRect().top; return [...document.querySelectorAll('.syn-sec')].every((e) => e.getBoundingClientRect().top > r); })));
check('latest (v2) shown by default', (await meta()).endsWith('5 voices / 7 contributions') && (await p.locator('.syn-status').innerText()).replace(/\s+/g, ' ').trim() === 'Current through all submitted contributions.');
const reqs = []; p.on('request', (r) => { if (r.url().includes('/api/synthesize') && r.method() === 'POST') reqs.push(r.url()); });
const callsV = await llmCalls();
await p.selectOption('#syn-version', '1'); await p.waitForSelector('.syn-status.older');
await p.click('#acc-syn-commons .syn-shead').catch(() => {});
check('selecting v1 shows v1 exactly: its header and its stored pillars', (await meta()).endsWith('4 voices / 5 contributions') && (await p.locator('#acc-syn-commons-8').count()) === 1 && (await p.locator('#acc-syn-contested-1').count()) === 1);
check('selecting an old version does not regenerate anything', reqs.length === 0 && (await llmCalls()) === callsV && (await versions()).length === 2);
await p.click('button:has-text("Show the latest")');
check('"Show the latest" returns to v2', (await meta()).endsWith('5 voices / 7 contributions') && (await p.locator('#syn-version').inputValue()) === '2' && (await p.locator('.syn-status.older').count()) === 0 && (await p.locator('#acc-syn-commons-2').count()) === 1);
check('sparse output: consensus clamped to 0-100, or taken from the strength label when unusable', sparse.commons[0].consensus === 100 && sparse.commons[1].consensus === 0 && sparse.commons[1].strength === 'emerging');
check('sparse output: themes/quotes/suggestions capped and trimmed', sparse.commons[1].themes[0].length === 60 && sparse.commons[1].quotes.length === 2 && sparse.gaps[0].suggestions.length === 4);
check('sparse output: half-empty spectrum is dropped, position values clamped', sparse.contested[0].spectrum === null && sparse.contested[0].positions.map((x) => x.value).join() === '0,100');
check('sparse output: pillar participants are still names/Anonymous only', sparse.commons[0].participants.length === 1 && sparse.contested[0].participants.length === 2 && !JSON.stringify(sparse).includes(stranger));

// legacy saved synthesis (older shapes, no consensus/participants/spectrum) still renders
await p.evaluate(() => { S.acc = {}; S.synVersions = [{ version: 99, timestamp: Date.now(), count: 1, submissionCount: 1 }, ...S.synVersions]; S.synView = null; S.synBodies[99] = { commons: [{ pillar: 'OldC', summary: 'Old summary', strength: 'strong', voices: ['Me', '2 anonymous'] }], contested: [{ pillar: 'Old', positions: ['A view', 'B view'], tension: 't' }], gaps: [{ pillar: 'OldG', note: 'old note' }], timestamp: Date.now(), count: 1 }; render(); });
await p.click('#acc-syn-commons .syn-shead'); await p.click('#acc-syn-contested .syn-shead'); await p.click('#acc-syn-gaps .syn-shead'); await settle();
await p.click('#acc-syn-commons-OldC .syn-phead'); await p.click('#acc-syn-contested-Old .syn-phead'); await p.click('#acc-syn-gaps-OldG .syn-phead'); await settle();
check('legacy commons: bar from the strength label, pill counts people from the old voices list, summary shown', (await p.locator('#acc-syn-commons-OldC .syn-meter i').evaluate((e) => e.style.width)) === '85%' && (await p.locator('#acc-syn-commons-OldC .sugg-count').innerText()) === '(3)' && (await p.locator('#acc-syn-commons-OldC .syn-pts li').first().innerText()).includes('Old summary'));
check('legacy gaps (no pillarId, no suggestions) show just the note', (await p.locator('#acc-syn-gaps-OldG .syn-arrows').count()) === 0 && (await p.locator('#acc-syn-gaps-OldG .syn-note').innerText()) === 'old note');
check('legacy string positions render as Position N and there is no spectrum', (await p.locator('#acc-syn-contested-Old .syn-pts li .syn-by').first().innerText()) === '— Position 1' && (await p.locator('#acc-syn-contested-Old .syn-pts li').first().innerText()).includes('A view') && (await p.locator('#acc-syn-contested-Old .spec-track').count()) === 0);

// fact-check: the synthesis runs on Opus (medium), then Opus (medium) checks each credited source against its own words
const logBefore = (await (await fetch(B + '/__log')).json()).length;
await fetch(B + '/__synth?m=ok'); await fetch(B + '/__check?reject=' + encodeURIComponent('No deepfakes'));
await postService('/supabase/rest/v1/submissions', { pillars: [3], content: 'fact-check material', summary: 's', auto_tagged: false, is_test: false, participant_id: stranger, uid: null, display_name: '' });
const fc = await runApi();
const calls = (await (await fetch(B + '/__log')).json()).slice(logBefore).filter((x) => x.anthropic?.output_config).map((x) => x.anthropic);
const synCall = calls.find((c) => c.output_config.format.schema.properties.commons), checkCalls = calls.filter((c) => c.output_config.format.schema.properties.results);
check('synthesis call uses Opus 5.5 at medium effort', synCall?.model === 'claude-opus-5-5' && synCall.output_config.effort === 'medium');
check('fact-check: one Opus 5.5 call per credited source, at medium effort', checkCalls.length >= 2 && checkCalls.every((c) => c.model === 'claude-opus-5-5' && c.output_config.effort === 'medium'));
check('fact-check prompts hold one source\'s own words and the statements, never run-local labels', checkCalls.every((c) => { const t = c.messages[0].content; return t.includes('<contribution>') && t.includes('<statement id="1"') && !/Participant [A-Z]+ source|Source \d+ \(/.test(t); }));
const deep = fc.commons?.[0]?.points?.find((x) => x.point.startsWith('No deepfakes'));
const discl = fc.commons?.[0]?.points?.find((x) => x.point.includes('disclosure'));
check('unsupported credits are removed, the point itself stays', !!deep && deep.voices.length === 0 && discl.voices.length > 0);
check('fact-check result reported: credits checked and removed', fc.factCheck?.removed >= 2 && fc.factCheck.checked > fc.factCheck.removed && fc.factCheck.failed === 0, JSON.stringify(fc.factCheck));
await fetch(B + '/__check?m=fail');
await postService('/supabase/rest/v1/submissions', { pillars: [3], content: 'more fact-check material', summary: 's', auto_tagged: false, is_test: false, participant_id: stranger, uid: null, display_name: '' });
const fc2 = await runApi();
check('a failing fact-check never breaks the synthesis: version saved, credits kept', Number.isInteger(fc2.version) && fc2.factCheck?.failed > 0 && fc2.factCheck.removed === 0 && fc2.commons[0].points.find((x) => x.point.startsWith('No deepfakes')).voices.length > 0, JSON.stringify(fc2.factCheck));
await fetch(B + '/__check');

// editing an already-synthesized contribution is new material (it is not a new contribution)
await runApi();   // bring the latest version up to date with everything before this block
const e0 = (await statusApi()).pending;
check('before any edit: nothing edited, nothing pending', e0.edited === 0 && e0.changed === false, JSON.stringify(e0));
await fetch(B + '/__edit?from=' + encodeURIComponent('newcomer thought') + '&to=' + encodeURIComponent('newcomer thought'));
check('saving identical text does not count as an edit', (await statusApi()).pending.edited === 0);
await new Promise((r) => setTimeout(r, 30));
await fetch(B + '/__edit?from=' + encodeURIComponent('newcomer thought') + '&to=' + encodeURIComponent('newcomer thought, now with a revised view'));
const e1 = await statusApi();
check('an edit counts as changed material, with no new contribution or voice', e1.pending.edited === 1 && e1.pending.contributions === 0 && e1.pending.voices === 0 && e1.pending.removed === 0 && e1.pending.changed === true, JSON.stringify(e1.pending));
await p.evaluate(() => { S.synStatusKey = ''; render(); }); await p.waitForSelector('.syn-status.pending');
check('the Synthesis page says it was edited', (await p.locator('.syn-status').innerText()).replace(/\s+/g, ' ').trim() === '1 contribution in the latest synthesis has been edited since. The next synthesis will read the new text.');
const nBefore = (await versions()).length, callsE = await llmCalls();
const runE = await runApi();
check('running again makes a NEW version from the edited text', runE.unchanged === false && (await versions()).length === nBefore + 1 && (await llmCalls()) === callsE + 1);
const promptE = (await (await fetch(B + "/__log")).json()).filter((x) => x.anthropic?.output_config?.format?.schema?.properties?.commons).pop().anthropic.messages[0].content;
check('the new version read the edited words, not the old ones', promptE.includes('now with a revised view'));
const gv = (await versions()).at(-1);
check('the version remembers when it read the contributions (before it was saved)', !!gv.gathered_at && Date.parse(gv.gathered_at) <= Date.parse(gv.created_at));
check('afterwards the edit is no longer pending', (await statusApi()).pending.edited === 0 && (await statusApi()).pending.changed === false);

// a version made with the original 12 pillars keeps its own names, emojis and "/ 12"
await p.evaluate(() => { S.acc = {}; S.synVersions = [{ version: 98, timestamp: Date.now(), count: 2, submissionCount: 2 }, ...S.synVersions]; S.synView = null;
  S.synBodies[98] = { commons: [{ pillarId: 10, pillar: 'AI Presence, Identity & Immediacy', consensus: 70, points: [{ point: 'p', voices: ['A'] }], participants: ['A'] }], contested: [], gaps: [{ pillarId: 11, pillar: 'The Default World Bridge', note: 'n', suggestions: ['s'] }] }; render(); });
await p.click('#acc-syn-commons .syn-shead'); await p.click('#acc-syn-gaps .syn-shead'); await settle();
check('old 12-pillar version: its own pillar names with their old emojis, out of 12', (await p.locator('#acc-syn-commons-10 .syn-pname').innerText()) === '🤖 AI Presence, Identity & Immediacy' && (await p.locator('#acc-syn-gaps-11 .syn-pname').innerText()) === '🌉 The Default World Bridge' && (await p.locator('.syn-stat:has-text("Pillars covered") .syn-num').innerText()).replace(/\s+/g, ' ') === '1 / 12');
check('a version made with the new pillars is out of 8', await p.evaluate(() => synPillarTotal({ commons: [{ pillar: 'Governance & Accountability' }] })) === 8);

// test personas are gone
check('no "Testing as" persona switcher or persona code left', (await p.locator('.persona-row').count()) === 0 && (await p.evaluate(() => typeof setPersona === 'undefined' && typeof PERSONAS === 'undefined')));
check('no page errors', errs.length === 0, errs.join('|'));
console.log(`\n${pass}/${total} passed`); await b.close();
