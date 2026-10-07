// Runs every suite and prints a summary. Exit code 1 if anything fails.
// Browser suites each get a fresh fake backend (tests/harness.mjs) so they can't affect each other.
import { spawn } from 'node:child_process';
import { HERE } from './lib.mjs';

const browser = ['app.e2e.mjs', 'delete.e2e.mjs', 'mark-test.e2e.mjs', 'persona.e2e.mjs', 'files.e2e.mjs', 'wizard.e2e.mjs', 'voices.e2e.mjs'];
const plain = ['gate.test.mjs', 'google-doc.test.mjs', 'email-hook.test.mjs', 'sql-auth.test.mjs', 'sql-delete.test.mjs', 'sql-mark-test.test.mjs', 'sql-seed.test.mjs', 'sql-wizard.test.mjs'];
const only = process.argv[2]; // optional: run a single suite, e.g. `npm test -- persona`

const run = (file) =>
  new Promise((resolve) => {
    const p = spawn('node', [file], { cwd: HERE });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
  });

const results = [];
for (const file of [...plain, ...browser]) {
  if (only && !file.includes(only)) continue;
  let harness;
  if (browser.includes(file)) {
    harness = spawn('node', ['harness.mjs'], { cwd: HERE, stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 1500));
  }
  const { code, out } = await run(file);
  harness?.kill();
  const m = out.match(/(\d+)\/(\d+) passed/);
  const ok = code === 0 && m && m[1] === m[2];
  results.push({ file, ok, summary: m ? `${m[1]}/${m[2]}` : 'crashed' });
  if (!ok) console.log(`\n--- ${file} output ---\n${out.split('\n').filter((l) => /FAIL|Error|error/.test(l)).join('\n') || out.slice(-1500)}\n`);
}

console.log('\nSuite'.padEnd(32) + 'Result');
for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.file.padEnd(28)}${r.summary}`);
const bad = results.filter((r) => !r.ok).length;
console.log(bad ? `\n${bad} suite(s) failed` : '\nAll suites passed');
process.exit(bad ? 1 : 0);
