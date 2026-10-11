// The transcript splitter must use labels literally; it may never infer people.
import fs from 'node:fs';
import vm from 'node:vm';
import { ROOT } from './lib.mjs';

let pass = 0, total = 0;
const check = (n, ok) => { total++; if (ok) pass++; console.log(ok ? 'PASS' : 'FAIL', n); };
const sandbox = { crypto: { randomUUID: () => 'test-run' }, console, setInterval, clearInterval, setTimeout, clearTimeout };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(ROOT + '/public/wizard.js', 'utf8'), sandbox, { filename: 'public/wizard.js' });
const split = sandbox.wzTranscriptSpeakers;

const labels = split('Participant A: Consent first.\nParticipant B: Let people opt out.\nParticipant A: Make it visible.');
check('keeps two labelled speakers distinct and aggregates repeated turns', labels.length === 2 && labels[0].label === 'Participant A' && labels[0].content === 'Consent first.\nMake it visible.' && labels[1].label === 'Participant B' && labels.every((v) => v.detected));
check('preserves a label literally rather than resolving a real identity', labels[0].label === 'Participant A');
const unknown = split('A conversation with no speaker labels at all.');
check('does not invent speakers when no labels exist', unknown.length === 1 && unknown[0].label === 'Unlabeled transcript' && !unknown[0].detected);
const note = split('Note: this was copied from a workshop.\nParticipant A: Consent first.');
check('does not mistake a generic Note prefix for a person', note.some((v) => v.label === 'Participant A') && !note.some((v) => v.label === 'Note'));

console.log(`\n${pass}/${total} passed`);
