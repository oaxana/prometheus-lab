import { launch } from './lib.mjs'; import fs from 'node:fs';
const B = 'http://localhost:4173'; let pass = 0, total = 0;
const check = (n, ok, x = '') => { total++; if (ok) pass++; console.log(ok ? 'PASS' : 'FAIL', n, x); };
const b = await launch();
const p = await (await b.newContext({ viewport: { width: 420, height: 900 }, colorScheme: 'dark' })).newPage();
const errs = []; p.on('pageerror', (e) => errs.push(String(e))); p.on('dialog', (d) => d.accept());
const input = '#drop-zone input[type=file]';
const GOOD = 'https://docs.google.com/document/d/GOODDOCaaaaaaaaaaaaaaaaaaaaaaaaaaaa/edit?usp=sharing';
const SLIDES = 'https://docs.google.com/presentation/d/GOODSLIDESaaaaaaaaaaaaaaaaaaaaaa/edit#slide=id.p';
const names = async () => p.locator('.file-preview .name').allInnerTexts();
await p.goto(B); await p.click('nav button:has-text("Submit")');
await p.fill('#auth-email','files@example.com');await p.click('button:has-text("Send code")');await p.fill('#auth-code','123456');await p.click('button:has-text("Verify")');await p.waitForSelector('#drop-zone');
await p.locator('.toast').waitFor({state:'detached'});
check('drop zone lists .pptx', (await p.locator('.drop-zone').innerText()).includes('.pptx'));
check('file input accepts .pptx', (await p.locator(input).getAttribute('accept')).includes('.pptx'));

// ---- PowerPoint
await p.setInputFiles(input, 'fixtures/test.pptx'); await p.waitForSelector('.file-preview');
check('pptx attached as a text file chip', (await names()).join() === 'test.pptx' && (await p.locator('.file-preview').innerText()).includes('chars'));
// ---- legacy .ppt
await p.setInputFiles(input, 'fixtures/legacy.ppt'); await p.waitForSelector('.toast');
check('legacy .ppt -> helpful toast, not attached', (await p.locator('.toast').first().innerText()).includes('save it as .pptx') && (await names()).length === 1);
// ---- Google Doc link
await p.fill('#gdoc-url', GOOD); await p.click('button:has-text("Add")');
await p.waitForFunction(() => document.querySelectorAll('.file-preview').length === 2);
check('Google Doc added, titled from Google', (await names()).includes('Doc: Camp Plan'), (await names()).join(' | '));
check('link box cleared after adding', (await p.inputValue('#gdoc-url')) === '');
// ---- Google Slides link via Enter key
await p.fill('#gdoc-url', SLIDES); await p.press('#gdoc-url', 'Enter');
await p.waitForFunction(() => document.querySelectorAll('.file-preview').length === 3);
check('Google Slides added (Enter key)', (await names()).includes('Slides: Camp Deck'));
// ---- private + junk links
await p.fill('#gdoc-url', 'https://docs.google.com/document/d/PRIVATEDOCaaaaaaaaaaaaaaaaaaaaaaaaa/edit'); await p.click('button:has-text("Add")');
await p.waitForSelector('.toast:has-text("Anyone with the link")');
check('private doc -> toast tells you how to share it', (await names()).length === 3);
await p.fill('#gdoc-url', 'https://example.com/whatever'); await p.click('button:has-text("Add")');
await p.waitForSelector('.toast:has-text("doesn’t look like")');
check('non-Google link rejected client-side (no request)', (await names()).length === 3);
// typed text and link text survive a re-render
await p.fill('#voice-text', 'My own words.'); await p.fill('#gdoc-url', 'half typed link');
await p.click('.toggle-row:has-text("Test submission")');
check('typed text + half-typed link survive re-render', (await p.inputValue('#voice-text')) === 'My own words.' && (await p.inputValue('#gdoc-url')) === 'half typed link');
await p.fill('#gdoc-url', ''); await p.screenshot({ path: 'screens/shot-files.png', fullPage: false });
await p.click('.file-preview >> nth=2 >> .remove'); // remove the slides chip
check('a Google chip can be removed', (await names()).length === 2);

// ---- submit and inspect what Claude receives
await p.click('main .btn-primary:has-text("Submit")'); await p.waitForSelector('h2:has-text("All Voices")');
const log = await (await fetch(B + '/__log')).json();
const msg = log.filter((x) => x.anthropic).pop().anthropic.messages[0].content;
const prompt = (Array.isArray(msg) ? msg.at(-1).text : msg);
check('prompt has typed text', prompt.includes('My own words.'));
check('prompt has [From: test.pptx] block', prompt.includes('[From: test.pptx]'));
const iOpen = prompt.indexOf('OPENING: AI must say'), iSecond = prompt.indexOf('SECOND: Data is deleted');
check('slides in PRESENTATION order (slide2.xml before slide1.xml)', iOpen > -1 && iSecond > iOpen);
check('"Slide 1" label is the first slide in the deck', /Slide 1\nOPENING/.test(prompt) && /Slide 2\nSECOND/.test(prompt));
check('XML entity decoded (&amp; -> &)', prompt.includes('trust & honesty'));
check('speaker notes included, attached to the right slide', /SECOND: Data is deleted after the burn\nSpeaker notes: NOTE: mention retention limits/.test(prompt));
check('slide-number fields skipped (no stray "1", "2", "9")', !/Speaker notes: NOTE: mention retention limits 9/.test(prompt) && !/OPENING[^\n]*\n[^\n]*\n1\n/.test(prompt));
check('Google Doc text in prompt, with its title', prompt.includes('[From: Doc: Camp Plan]') && prompt.includes('GOOGLEDOC-MARKER'));
check('removed Google Slides chip is NOT in prompt', !prompt.includes('GOOGLESLIDES-MARKER'));
const row = (await (await fetch(B + '/__db')).json()).submissions.at(-1);
check('full text stored with the submission', row.content.includes('OPENING') && row.content.includes('GOOGLEDOC-MARKER') && row.content.includes('My own words.'));
check('no page errors', errs.length === 0, errs.join('|'));
console.log(`\n${pass}/${total} passed`); await b.close();
