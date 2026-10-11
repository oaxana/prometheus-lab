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

// Meeting-tool markdown export: bold names, timestamps, a header block; names cleaned to the person's name.
const md = split(`# Constitution workshop

**Meeting Date:** 1st Oct, 2026 - 2:38 AM

---

**jordan lee** *[10:23]*: Hey, Mia.
**Robin O'Hara - Example Studio Productions** *[12:19]*: Yeah.
**Casey M Park** *[13:01]*: Consent matters.
**Jordan Lee** *[13:05]*: Agreed.`);
check('meeting-tool export: one voice per person, header lines are not voices', md.map((v) => v.label).join('|') === "Jordan Lee|Robin O'Hara|Casey Park" && md.every((v) => v.detected) && !md.some((v) => /Meeting Date|Constitution workshop/.test(v.content)));
check('meeting-tool export: lowercase and capitalised spellings of one name merge', md[0].content === 'Hey, Mia.\nAgreed.');
const names = split('[00:01:02] jane DOE: hello\n00:02 Dr. Mary Ann Smith-Jones (Acme Inc): second\nTaylor Wong [10:23]: one\nsam | Org: three\nAvery, Facilitator: four\n[00:03] JANE DOE: again');
check('names: timestamps, titles, companies and initials removed; real multi-part names kept', names.map((v) => v.label).join('|') === 'Jane Doe|Mary Ann Smith-Jones|Taylor Wong|Sam|Avery' && names[0].content === 'hello\nagain');
const plain = split("Robin O'Hara - Example Studio Productions: Yeah.\nMia Stone — I agree\nQuestion: is that fine?\nSo here is the thing that I keep thinking about: privacy.");
check('a colon beats a dash; "Question:" and long sentences are not speakers', plain.map((v) => v.label).join('|') === "Robin O'Hara|Mia Stone" && plain[1].content.includes('Question: is that fine?'));
check('"Participant A" stays exactly that', split('Participant A: hi\nParticipant B: yo').map((v) => v.label).join('|') === 'Participant A|Participant B');

console.log(`\n${pass}/${total} passed`);
