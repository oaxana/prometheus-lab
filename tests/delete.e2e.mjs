import { launch } from './lib.mjs';
const B = 'http://localhost:4173'; let pass = 0, total = 0;
const check = (n, ok, x = '') => { total++; if (ok) pass++; console.log(ok ? 'PASS' : 'FAIL', n, x); };
const b = await launch();
const ctx = await b.newContext({ viewport: { width: 420, height: 900 } }); const p = await ctx.newPage();
const dialogs = []; let accept = false;
p.on('dialog', async (d) => { dialogs.push(d.message()); accept ? await d.accept() : await d.dismiss(); });
const errs = []; p.on('pageerror', (e) => errs.push(String(e)));
const submit = async (text) => { await p.click('nav button:has-text("Submit")'); await p.fill('#voice-text', text); await p.click('main .btn-primary:has-text("Submit")'); await p.waitForSelector('.submission-card'); };
await p.goto(B); await submit('first voice'); await submit('second voice');
check('two cards, each with Delete', (await p.locator('.submission-card').count()) === 2 && (await p.locator('button:has-text("Delete")').count()) === 2);
await p.screenshot({ path: 'screens/shot-delete.png', fullPage: true });
// cancel the confirm -> nothing deleted
accept = false; await p.locator('button:has-text("Delete")').first().click();
check('confirm dialog shown', dialogs.at(-1).includes('cannot be undone'));
check('cancel keeps both', (await p.locator('.submission-card').count()) === 2);
// accept -> deleted, toast, count updates
accept = true; await p.locator('button:has-text("Delete")').first().click();
await p.waitForFunction(() => document.querySelectorAll('.submission-card').length === 1);
check('accept deletes one card', true);
check('toast shown', await p.locator('.toast:has-text("deleted")').isVisible());
check('heading count updates to (1)', (await p.locator('h2').first().innerText()).includes('(1)'));
// another visitor: sees remaining card, no Delete button, and a forged delete fails
const p2 = await (await b.newContext()).newPage(); await p2.goto(B); await p2.click('nav button:has-text("Voices")'); await p2.waitForSelector('.submission-card');
check("other visitor sees the card but no Delete", (await p2.locator('button:has-text("Delete")').count()) === 0);
const id = (await (await fetch(B + '/__db')).json()).submissions[0].id;
const forged = await p2.evaluate(async ([id]) => (await sb.rpc('delete_my_submission', { p_id: id, p_uid: 'someone-elses-uid' })).data, [id]);
check('forged delete by other visitor returns false', forged === false);
check('row still exists after forged attempt', (await (await fetch(B + '/__db')).json()).submissions.length === 1);
check('no page errors', errs.length === 0, errs.join('|'));
console.log(`\n${pass}/${total} passed`); await b.close();
