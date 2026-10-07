import { buildVerificationEmail } from '../supabase/functions/send-email/email.js';

let pass = 0, total = 0;
const check = (name, ok) => {
  total++;
  if (ok) pass++;
  console.log(ok ? 'PASS' : 'FAIL', name);
};

const email = buildVerificationEmail('123456');
check('uses the Prometheus Lab subject', email.subject === 'Your Prometheus Lab verification code');
check('plain text contains the OTP', email.text.includes('123456'));
check('HTML contains the OTP', email.html.includes('123456'));
check('privacy promise is included', email.text.includes('never shown to other participants') && email.html.includes('never shown to other participants'));
check('does not contain a recipient, UUID, or auth session', !/@/.test(email.text + email.html) && !/session|uuid/i.test(email.text + email.html));

const escaped = buildVerificationEmail('<script>alert(1)</script>');
check('HTML-escapes an unexpected token value', !escaped.html.includes('<script>') && escaped.html.includes('&lt;script&gt;'));

let rejected = false;
try { buildVerificationEmail('  '); } catch { rejected = true; }
check('rejects a missing OTP', rejected);

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
