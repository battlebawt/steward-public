import { z } from 'zod';
import { AddressSchema } from '@steward/shared';
import type { AdmissionRequest, EligibilityDecision, MarketObservation } from './admission';

const timestamp = z.number().int().positive().safe();
const eligibilitySchema = z.object({
  status: z.enum(['allowed', 'blocked', 'review-required', 'unknown']),
  account: AddressSchema, actor: AddressSchema, asset: AddressSchema,
  chainId: z.number().int().positive().safe(), side: z.enum(['BUY', 'SELL']),
  policyVersion: z.string().min(1).max(100), source: z.string().min(1).max(200),
  evidence: z.string().min(1).max(500), observedAt: timestamp, expiresAt: timestamp,
}).strict();
const marketSchema = z.object({
  chainId: z.number().int().positive().safe(), asset: AddressSchema,
  session: z.enum(['market', 'extended', 'overnight']), state: z.enum(['open', 'closed', 'unknown']),
  halted: z.boolean(), source: z.string().min(1).max(200), observedAt: timestamp, expiresAt: timestamp,
}).strict();

function exactHttpsUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || url.origin === 'null') throw Error('ADMISSION_SOURCE_URL_INVALID');
  return url.href;
}

/** Operator-configured evidence endpoints. Their responses are data, never an admission override. */
export function createHttpAdmissionSources(options: { eligibilityUrl: string; marketUrl: string; apiKey: string; fetcher?: typeof fetch }) {
  const eligibilityUrl = exactHttpsUrl(options.eligibilityUrl);
  const marketUrl = exactHttpsUrl(options.marketUrl);
  if (!options.apiKey || /[\r\n]/.test(options.apiKey)) throw Error('ADMISSION_SOURCE_KEY_INVALID');
  const fetcher = options.fetcher ?? fetch;
  async function request(url: string, input: AdmissionRequest): Promise<unknown> {
    const response = await fetcher(url, {
      method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(4000),
      headers: { 'authorization': `Bearer ${options.apiKey}`, 'content-type': 'application/json', 'accept': 'application/json', 'cache-control': 'no-store' },
      body: JSON.stringify(input),
    });
    if (!response.ok || !response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw Error('ADMISSION_SOURCE_UNAVAILABLE');
    if (!response.body) throw Error('ADMISSION_SOURCE_EMPTY');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16_384) { await reader.cancel(); throw Error('ADMISSION_SOURCE_RESPONSE_TOO_LARGE'); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  }
  return {
    eligibility: async (input: AdmissionRequest): Promise<EligibilityDecision> => eligibilitySchema.parse(await request(eligibilityUrl, input)),
    market: async (input: AdmissionRequest): Promise<MarketObservation> => marketSchema.parse(await request(marketUrl, input)),
  };
}
