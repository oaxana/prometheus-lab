const escapeHtml = (value) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

export function buildVerificationEmail(token) {
  const code = String(token || '').trim();
  if (!code) throw new Error('The Supabase email payload did not include a verification code.');

  const safeCode = escapeHtml(code);
  return {
    subject: 'Your Prometheus Lab verification code',
    text: [
      'Your Prometheus Lab verification code',
      '',
      `Enter this code in Prometheus Lab: ${code}`,
      '',
      'This code verifies that you are one participant.',
      'Your email is never shown to other participants or sent to the synthesis model.',
      '',
      'If you did not request this code, you can ignore this email.',
    ].join('\n'),
    html: `
      <!doctype html>
      <html lang="en">
        <body style="margin:0;background:#f7f4ee;color:#211f1b;font-family:Arial,sans-serif;">
          <div style="max-width:560px;margin:0 auto;padding:40px 24px;">
            <h1 style="font-size:24px;margin:0 0 18px;">Your Prometheus Lab verification code</h1>
            <p style="font-size:16px;line-height:1.5;">Enter this code in Prometheus Lab:</p>
            <p style="font-size:32px;font-weight:700;letter-spacing:6px;margin:24px 0;">${safeCode}</p>
            <p style="font-size:15px;line-height:1.6;">This code verifies that you are one participant. Your email is never shown to other participants or sent to the synthesis model.</p>
            <p style="font-size:13px;line-height:1.5;color:#666;margin-top:28px;">If you did not request this code, you can ignore this email.</p>
          </div>
        </body>
      </html>`,
  };
}
