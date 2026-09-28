import { expect, test } from 'bun:test';
import { createHttpAdmissionSources } from './admission-http';
import type { AdmissionRequest } from './admission';

const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as `0x${string}`;
const input: AdmissionRequest = { account: a(1), actor: a(2), asset: a(3), chainId: 4663, policyVersion: '5', side: 'SELL', session: 'market' };

test('configured admission endpoints receive exact actor-bound POSTs and validate evidence', async () => {
  const seen: Array<{ url: string; request: RequestInit }> = [];
  const fetcher = async (url: URL | RequestInfo, request?: RequestInit) => {
    seen.push({ url: String(url), request: request! });
    const common = { chainId: input.chainId, asset: input.asset, source: 'reviewed-fixture', observedAt: 100_000, expiresAt: 120_000 };
    const result = String(url).endsWith('/eligibility')
      ? { ...common, account: input.account, actor: input.actor, side: input.side, policyVersion: input.policyVersion, status: 'allowed', evidence: 'fixture-proof' }
      : { ...common, session: input.session, state: 'open', halted: false };
    return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
  };
  const sources = createHttpAdmissionSources({ eligibilityUrl: 'https://review.example.invalid/eligibility', marketUrl: 'https://market.example.invalid/session', apiKey: 'fixture-key', fetcher: fetcher as typeof fetch });
  expect((await sources.eligibility(input)).actor).toBe(input.actor);
  expect((await sources.market(input)).state).toBe('open');
  expect(seen.map((item) => item.url)).toEqual(['https://review.example.invalid/eligibility', 'https://market.example.invalid/session']);
  for (const { request } of seen) {
    expect(request.method).toBe('POST');
    expect(request.redirect).toBe('error');
    expect(JSON.parse(String(request.body))).toEqual(input);
    expect(new Headers(request.headers).get('authorization')).toBe('Bearer fixture-key');
  }
  expect(() => createHttpAdmissionSources({ eligibilityUrl: 'http://review.example.invalid', marketUrl: 'https://market.example.invalid', apiKey: 'fixture' })).toThrow('ADMISSION_SOURCE_URL_INVALID');
});

test('malformed or oversized admission evidence is rejected', async () => {
  let body: unknown = { allowed: true };
  const sources = createHttpAdmissionSources({ eligibilityUrl: 'https://review.example.invalid/eligibility', marketUrl: 'https://market.example.invalid/session', apiKey: 'fixture', fetcher: (async () => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch });
  await expect(sources.eligibility(input)).rejects.toThrow();
  body = { data: 'x'.repeat(20_000) };
  await expect(sources.market(input)).rejects.toThrow('ADMISSION_SOURCE_RESPONSE_TOO_LARGE');
});
