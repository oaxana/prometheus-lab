import { launch, runWizard } from './lib.mjs';
const B = 'http://localhost:4173'; let pass = 0, total = 0;
const check = (n, ok, x = '') => { total++; if (ok) pass++; console.log(ok ? 'PASS' : 'FAIL', n, x); };
const b = await launch();
const p = await (await b.newContext({ viewport: { width: 420, height: 900 }, colorScheme: 'dark' })).newPage();
const errs = []; p.on('pageerror', (e) => errs.push(String(e))); p.on('dialog', (d) => d.accept());
const input = '#wz-file';
const GOOD = 'https://docs.google.com/document/d/GOODDOCaaaaaaaaaaaaaaaaaaaaaaaaaaaa/edit?usp=sharing';
const SLIDES = 'https://docs.google.com/presentation/d/GOODSLIDESaaaaaaaaaaaaaaaaaaaaaa/edit#slide=id.p';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const chip = async () => p.locator('.file-preview .name').allInnerTexts();
const nextEnabled = async () => p.locator('.wz-nav .btn-amber').isEnabled();
const db = async () => (await fetch(B + '/__db')).json();
const lastPrompt = async () => { const log = await (await fetch(B + '/__log')).json(); const m = log.filter((x) => x.anthropic).pop().anthropic.messages[0].content; return Array.isArray(m) ? m : [{ type: 'text', text: m }]; };
await p.goto(B); await p.click('nav button:has-text("Submit")');
await p.fill('#auth-email','files@example.com');await p.click('button:has-text("Send code")');await p.fill('#auth-code','123456');await p.click('button:has-text("Verify")');await p.waitForSelector('#wz-start');
await p.locator('.toast').waitFor({state:'detached'});

// ---- reach step 5 in upload mode
await runWizard(p, { mode: 'upload', stopAt: 5 });
check('drop zone lists the supported formats', (await p.locator('.drop-zone').innerText()).includes('PPTX'));
const accept = await p.locator(input).getAttribute('accept');
check('file input accepts every listed type', ['.pdf', '.doc', '.docx', '.ppt', '.pptx', '.png', '.jpg', '.jpeg', '.gif'].every((e) => accept.split(',').includes(e)), accept);
check('Next is blocked until something is attached', !(await nextEnabled()));

// ---- PowerPoint
await p.setInputFiles(input, 'fixtures/test.pptx'); await p.waitForSelector('.file-preview .wz-meta:not(:has-text("reading"))');
check('pptx shows filename and size', (await chip()).join() === 'test.pptx' && /\d+(\.\d)? (KB|MB)/.test(await p.locator('.file-preview .wz-meta').innerText()));
check('readable pptx needs no note and enables Next', (await nextEnabled()) && (await p.locator('.wz-note').count()) === 0);
// ---- legacy .ppt: stored, but we cannot read it, so a note is required
await p.setInputFiles(input, 'fixtures/legacy.ppt'); await p.waitForSelector('.wz-note');
check('legacy .ppt is accepted but asks for a note', (await p.locator('.wz-note').innerText()).includes('add a few sentences') && (await chip()).join() === 'legacy.ppt');
check('legacy .ppt: Next blocked until the note is written', !(await nextEnabled()));
await p.fill('#upload-note', 'Old deck about consent signage.');
check('typing the note enables Next live', await nextEnabled());
// ---- unsupported type
await p.setInputFiles(input, { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('plain') });
await p.waitForSelector('.toast:has-text("isn’t supported")');
check('unsupported type -> toast, previous file kept', (await chip()).join() === 'legacy.ppt');
// ---- Google Doc link replaces the file
await p.fill('#gdoc-url', GOOD); await p.click('button:has-text("Add")');
await p.waitForFunction(() => document.querySelector('.file-preview .name')?.textContent === 'Doc: Camp Plan');
check('Google Doc added, titled from Google, replaces the file', (await chip()).join() === 'Doc: Camp Plan');
check('link box cleared after adding', (await p.inputValue('#gdoc-url')) === '');
// ---- Google Slides link via Enter key
await p.fill('#gdoc-url', SLIDES); await p.press('#gdoc-url', 'Enter');
await p.waitForFunction(() => document.querySelector('.file-preview .name')?.textContent === 'Slides: Camp Deck');
check('Google Slides added (Enter key)', true);
// ---- private + junk links
await p.fill('#gdoc-url', 'https://docs.google.com/document/d/PRIVATEDOCaaaaaaaaaaaaaaaaaaaaaaaaa/edit'); await p.click('button:has-text("Add")');
await p.waitForSelector('.toast:has-text("Anyone with the link")');
check('private doc -> toast tells you how to share it', (await chip()).join() === 'Slides: Camp Deck');
await p.fill('#gdoc-url', 'https://example.com/whatever'); await p.click('button:has-text("Add")');
await p.waitForSelector('.toast:has-text("doesn’t look like")');
check('non-Google link rejected client-side', (await chip()).join() === 'Slides: Camp Deck');
// typed note and half-typed link survive a re-render
await p.fill('#upload-note', 'My own words.'); await p.fill('#gdoc-url', 'half typed link');
await p.evaluate(() => render());
check('note + half-typed link survive re-render', (await p.inputValue('#upload-note')) === 'My own words.' && (await p.inputValue('#gdoc-url')) === 'half typed link');
await p.fill('#gdoc-url', '');
await p.screenshot({ path: 'screens/shot-files.png', fullPage: false });
await p.click('.file-preview .remove');
check('a Google chip can be removed', (await chip()).length === 0);

// ---- submit a real .pptx and inspect what Claude receives and what is stored
await p.setInputFiles(input, 'fixtures/test.pptx'); await p.waitForSelector('.file-preview .wz-meta:not(:has-text("reading"))');
await p.fill('#upload-note', 'My own words.');
await p.click('.wz-nav .btn-amber'); await p.waitForSelector('.wz-stepcount:has-text("Step 6")');
await p.click('.wz-nav .btn-amber'); await p.waitForSelector('.wz-stepcount:has-text("Step 7")');
check('review shows the filename', (await p.locator('.wz-review:has(h3:has-text("Your submission"))').innerText()).includes('test.pptx'));
await p.click('.wz-nav .btn-amber:has-text("Submit")'); await p.waitForSelector('.wz-confirm');
const prompt = (await lastPrompt()).at(-1).text;
check('prompt has the note', prompt.includes('My own words.'));
check('prompt has [From: test.pptx] block', prompt.includes('[From: test.pptx]'));
const iOpen = prompt.indexOf('OPENING: AI must say'), iSecond = prompt.indexOf('SECOND: Data is deleted');
check('slides in PRESENTATION order (slide2.xml before slide1.xml)', iOpen > -1 && iSecond > iOpen);
check('"Slide 1" label is the first slide in the deck', /Slide 1\nOPENING/.test(prompt) && /Slide 2\nSECOND/.test(prompt));
check('XML entity decoded (&amp; -> &)', prompt.includes('trust & honesty'));
check('speaker notes included, attached to the right slide', /SECOND: Data is deleted after the burn\nSpeaker notes: NOTE: mention retention limits/.test(prompt));
check('slide-number fields skipped (no stray "1", "2", "9")', !/Speaker notes: NOTE: mention retention limits 9/.test(prompt) && !/OPENING[^\n]*\n[^\n]*\n1\n/.test(prompt));
let state = await db(); let row = state.submissions.at(-1), obj = state.objects.at(-1);
check('full text stored with the submission', row.content.includes('OPENING') && row.content.includes('My own words.'));
check('file stored in the participant’s own private folder', state.objects.length === 1 && obj.path.startsWith(row.participant_id + '/') && row.file_url === obj.path && row.file_name === 'test.pptx' && row.input_mode === 'upload');
check('stored with the right content type', obj.type === 'application/vnd.openxmlformats-officedocument.presentationml.presentation', obj.type);

// ---- Google Doc submission: text goes to Claude, the link (not a storage path) is kept
await runWizard(p, { mode: 'upload', stopAt: 5 });
await p.fill('#gdoc-url', GOOD); await p.click('button:has-text("Add")'); await p.waitForSelector('.file-preview');
await p.click('.wz-nav .btn-amber'); await p.click('.wz-nav .btn-amber'); await p.click('.wz-nav .btn-amber:has-text("Submit")'); await p.waitForSelector('.wz-confirm');
check('Google Doc text in prompt, with its title', (await lastPrompt()).at(-1).text.includes('[From: Doc: Camp Plan]') && (await lastPrompt()).at(-1).text.includes('GOOGLEDOC-MARKER'));
state = await db(); row = state.submissions.at(-1);
check('Google link kept as file_url, no file uploaded for it', row.file_url === GOOD && state.objects.length === 1);

// ---- image: shrunk to JPEG and sent to Claude as an image block
await runWizard(p, { mode: 'upload', stopAt: 5 });
await p.setInputFiles(input, { name: 'pic.png', mimeType: 'image/png', buffer: PNG }); await p.waitForSelector('.file-preview .wz-meta:not(:has-text("reading"))');
check('readable image needs no note', await nextEnabled());
await p.click('.wz-nav .btn-amber'); await p.click('.wz-nav .btn-amber'); await p.click('.wz-nav .btn-amber:has-text("Submit")'); await p.waitForSelector('.wz-confirm');
const content = await lastPrompt();
check('image sent to Claude as an image block (jpeg)', content[0].type === 'image' && content[0].source.media_type === 'image/jpeg', content.map((c) => c.type).join(','));
state = await db(); obj = state.objects.at(-1);
check('original image stored as PNG (not the shrunk copy)', obj.type === 'image/png' && state.submissions.at(-1).content.includes('[Attached image: pic.png]'), obj.type);
check('no page errors', errs.length === 0, errs.join('|'));
console.log(`\n${pass}/${total} passed`); await b.close();
