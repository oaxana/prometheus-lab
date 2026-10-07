# Prometheus Lab Send Email Hook

This Supabase Edge Function replaces Supabase's built-in Auth mailer and sends the existing email OTP through Resend.

It requires three Supabase Edge Function secrets:

- `RESEND_API_KEY`: created in the Resend dashboard. Never commit it.
- `SEND_EMAIL_HOOK_SECRET`: generated while configuring the HTTP Send Email Hook in Supabase. Never commit it.
- `AUTH_EMAIL_FROM`: for example, `Prometheus Lab <no-reply@auth.example.com>`. The domain must be verified by Resend.

Deploy the function without JWT verification because Supabase Auth calls it as a signed webhook, not as a signed-in browser user:

```sh
supabase functions deploy send-email --no-verify-jwt
```

Configure `Authentication → Hooks → Send Email` as an HTTP hook pointing to:

```text
https://PROJECT_REF.supabase.co/functions/v1/send-email
```

Do not activate the hook until the Resend domain is verified, all three secrets are set, and this function is deployed. The function verifies the Standard Webhooks signature before accepting a request and never logs the recipient or OTP.
