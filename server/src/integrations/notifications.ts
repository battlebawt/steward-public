import { createHmac, timingSafeEqual } from 'node:crypto';
/** Provider adapter. Configure only after sender/domain verification and a delivery drill. */
export function createResendSender(config: { apiKey: string; from: string; recipientForAccount: (accountId: string) => Promise<string>; fetcher?: typeof fetch }) {
  if (!config.apiKey || !config.from) throw new Error('EMAIL_NOT_CONFIGURED');
  return async (input: { accountId: string; idempotencyKey: string; subject: string; text: string }) => {
    const recipient = await config.recipientForAccount(input.accountId);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient) || /[\r\n]/.test(recipient)) throw new Error('EMAIL_RECIPIENT_UNAVAILABLE');
    try {
      const response = await (config.fetcher ?? fetch)('https://api.resend.com/emails', { method: 'POST', signal: AbortSignal.timeout(10_000), redirect: 'error', headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': input.idempotencyKey }, body: JSON.stringify({ from: config.from, to: [recipient], subject: input.subject, text: input.text }) });
      if (!response.ok) throw Error();
      const json = await response.json() as { id?: string };
      if (typeof json.id !== 'string' || !json.id) throw Error();
      return { id: json.id };
    } catch { throw new Error('EMAIL_SEND_FAILED'); }
  };
}
/** Svix-compatible signed delivery webhook verification; authenticated raw body must be replay-deduped by event ID. */
export function verifyEmailWebhook(input: { rawBody: string; id: string; timestamp: string; signatures: string; secret: string; nowSeconds?: number }): { eventId: string; providerId: string; delivered: boolean; failed: boolean } {
  if (!/^\d+$/.test(input.timestamp) || Math.abs((input.nowSeconds ?? Date.now() / 1000) - Number(input.timestamp)) > 300 || input.rawBody.length > 65536) throw new Error('INVALID_WEBHOOK');
  const secret = Buffer.from(input.secret.replace(/^whsec_/, ''), 'base64');
  if (secret.length < 16) throw new Error('INVALID_WEBHOOK_KEY');
  const expected = createHmac('sha256', secret).update(`${input.id}.${input.timestamp}.${input.rawBody}`).digest();
  const valid = input.signatures.split(' ').some(part => {
    const [version, encoded] = part.split(','); if (version !== 'v1' || !encoded) return false;
    const signature = Buffer.from(encoded, 'base64'); return signature.length === expected.length && timingSafeEqual(signature, expected);
  });
  if (!valid) throw new Error('INVALID_WEBHOOK');
  let value: { type?: string; data?: { email_id?: string } };
  try { value = JSON.parse(input.rawBody); } catch { throw new Error('INVALID_WEBHOOK'); }
  if (typeof value.data?.email_id !== 'string') throw new Error('INVALID_WEBHOOK');
  return { eventId: input.id, providerId: value.data.email_id, delivered: value.type === 'email.delivered', failed: ['email.bounced','email.failed','email.complained','email.suppressed'].includes(value.type??'') };
}
