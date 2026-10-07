// Shared test helpers.
import { chromium } from 'playwright';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
fs.mkdirSync(path.join(HERE, 'screens'), { recursive: true });

// Uses your installed Google Chrome. No Chrome? Run `npx playwright install chromium` and set PW_CHANNEL=chromium.
export const launch = () => chromium.launch({ channel: process.env.PW_CHANNEL || 'chrome', headless: true });

// Chrome with a fake microphone, for the voice-recording tests.
export const launchWithMic = () => chromium.launch({
  channel: process.env.PW_CHANNEL || 'chrome', headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});

// Stand-in for the browser's speech service: says "Quiet hours matter" shortly after start().
export const FAKE_SPEECH = () => {
  class FakeSR {
    start() { this._on = true; setTimeout(() => { if (this._on) this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: 'Quiet hours matter' }], { isFinal: true })] }); }, 300); }
    stop() { this._on = false; setTimeout(() => this.onend?.(), 20); }
  }
  window.webkitSpeechRecognition = FakeSR;
  window.SpeechRecognition = FakeSR;   // newer Chrome also exposes the unprefixed name
};

const NEXT = '.wz-nav .btn-amber';
// Clicks through the submission wizard. Pass stopAt (1-8) to stop when that step is showing.
// Needs a verified participant (or an unlocked test persona) already on the page.
export async function runWizard(p, o = {}) {
  const { text = 'AI should always disclose itself.', discovery = 'Consent and disclosure matter most.', anonymous = true, name, test = false,
    pillars = null, choice = 'selected', mode = 'text', type = '', upload = null, stopAt = 8, resume = false } = o;
  const at = async (n) => { await p.waitForSelector('.wz-stepcount:has-text("Step ' + n + ' of 8")'); };
  const next = async () => { await p.click(NEXT); };
  if (!resume) {   // resume: the caller already set up step 1 by hand
    await p.click('nav button:has-text("Submit")');
    await at(1);
    if (!anonymous) {
      await p.click('[data-fk=anon]');
      if (name && (await p.locator('#display-name').count())) await p.fill('#display-name', name);
    }
    if (test) await p.click('[data-fk=test]');
  }
  if (stopAt === 1) return;
  await p.click('#wz-start'); await at(2);
  if (stopAt === 2) return;
  await p.click('[data-fk=dm-text]'); await p.fill('#discovery-text', discovery); await next(); await at(3);
  await p.waitForSelector('.wz-pillars');
  if (choice !== 'selected') { await p.click(`[data-fk=${choice}]`); }
  else if (pillars) {
    for (let id = 1; id <= 12; id++) {
      const card = p.locator(`.wz-pillars [data-fk="p${id}"]`).last();
      const on = (await card.getAttribute('aria-pressed')) === 'true';
      if (on !== pillars.includes(id)) await card.click();
    }
  }
  if (stopAt === 3) return;
  await next(); await at(4);
  if (stopAt === 4) return;
  await p.click(`[data-fk=m-${mode}]`); await next(); await at(5);
  if (stopAt === 5) return;
  if (mode === 'text') await p.fill('#voice-text', text);
  if (mode === 'upload' && upload) await upload(p);
  await next(); await at(6);
  if (stopAt === 6) return;
  if (type) await p.fill('#contrib-type', type);
  await next(); await at(7);
  if (stopAt === 7) return;
  await p.click('.wz-nav .btn-amber:has-text("Submit")');
  await p.waitForSelector('.wz-confirm');
}
