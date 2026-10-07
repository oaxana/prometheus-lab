import { Webhook } from 'https://esm.sh/standardwebhooks@1.0.0';
import { buildVerificationEmail } from './email.js';

type SendEmailPayload = {
  user?: { email?: string };
  email_data?: { token?: string };
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const hookError = (status: number, message: string) => json({
  error: { http_code: status, message },
}, status);

const requiredEnv = (name: string) => {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};

Deno.serve(async (request) => {
  if (request.method !== 'POST') return hookError(405, 'Method not allowed.');

  let payload: SendEmailPayload;
  try {
    const body = await request.text();
    const secret = requiredEnv('SEND_EMAIL_HOOK_SECRET').replace(/^v1,whsec_/, '');
    payload = new Webhook(secret).verify(
      body,
      Object.fromEntries(request.headers),
    ) as SendEmailPayload;
  } catch (error) {
    console.error('Send Email Hook signature verification failed:', error instanceof Error ? error.message : 'unknown error');
    return hookError(401, 'Invalid webhook signature.');
  }

  const recipient = payload.user?.email?.trim();
  if (!recipient) return hookError(400, 'The email payload did not include a recipient.');

  let email;
  try {
    email = buildVerificationEmail(payload.email_data?.token);
  } catch (error) {
    console.error('Send Email Hook payload validation failed:', error instanceof Error ? error.message : 'unknown error');
    return hookError(400, 'The email payload did not include a verification code.');
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${requiredEnv('RESEND_API_KEY')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: requiredEnv('AUTH_EMAIL_FROM'),
        to: [recipient],
        subject: email.subject,
        text: email.text,
        html: email.html,
      }),
    });

    if (!response.ok) {
      console.error('Resend rejected the authentication email:', response.status);
      return hookError(502, 'The email provider could not send the verification code.');
    }
  } catch (error) {
    console.error('Resend request failed:', error instanceof Error ? error.message : 'unknown error');
    return hookError(502, 'The email provider could not send the verification code.');
  }

  return json({});
});
