import { expect, test } from 'bun:test';
import { keccak256 } from 'viem';
import { createDatabase } from '../db';
import { seedEnrollmentTokens } from './enrollment-tokens';
import type { ReadRpcPool } from './rpc';
import type { LiveManifest } from './live-chain';

const code = '0x6001' as const;
const address = `0x${'1'.repeat(40)}` as const;
const token = { address, runtimeCodeHash: keccak256(code), symbol: 'RUSD', name: 'Rehearsal settlement', decimals: 6, provider: 'fixture', sourceTermsVersion: 'fixture' };
const manifest: LiveManifest = { chainId: 31337, version: 'reviewed', accounts: [], routes: [], enrollmentTokens: [token] };
const rpc = (servedCode: string = code, decimals = 6) => ({ request: async (method: string) => method === 'eth_getCode' ? servedCode : `0x${decimals.toString(16).padStart(64, '0')}` }) as unknown as ReadRpcPool;

test('fresh live DB exposes only the configured verified settlement token', async () => {
  const db = createDatabase();
  try {
    await seedEnrollmentTokens(db, rpc(), manifest);
    const rows = db.query('SELECT address,decimals,legal_instrument_type,admission FROM assets').all() as Array<{ address: string; decimals: number; legal_instrument_type: string; admission: string }>;
    expect(rows).toEqual([{ address, decimals: 6, legal_instrument_type: 'settlement_token', admission: 'allowed' }]);
    await seedEnrollmentTokens(db, rpc(), { ...manifest, enrollmentTokens: [] });
    expect((db.query('SELECT admission FROM assets').get() as { admission: string }).admission).toBe('blocked');
  } finally { db.close(); }
});

test('wrong token code or units fail before catalog exposure', async () => {
  const db = createDatabase();
  try {
    await expect(seedEnrollmentTokens(db, rpc('0x6002'), manifest)).rejects.toThrow('CODE_MISMATCH');
    await expect(seedEnrollmentTokens(db, rpc(code, 18), manifest)).rejects.toThrow('DECIMALS_MISMATCH');
    expect(db.query('SELECT count(*) as n FROM assets').get()).toEqual({ n: 0 });
  } finally { db.close(); }
});
