import type { Database } from 'bun:sqlite';
import { decodeFunctionResult, encodeFunctionData, keccak256 } from 'viem';
import type { LiveManifest } from './live-chain';
import type { ReadRpcPool } from './rpc';

const decimalsAbi = [{ type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] }] as const;

/** Only reviewed, on-chain-verified settlement tokens are exposed for new accounts. */
export async function seedEnrollmentTokens(db: Database, rpc: ReadRpcPool, manifest: LiveManifest) {
  const verified = [] as Array<{ id: string; address: string; symbol: string; name: string; decimals: number; provider: string; sourceTermsVersion: string }>;
  for (const token of manifest.enrollmentTokens ?? []) {
    const code = await rpc.request<`0x${string}`>('eth_getCode', [token.address, 'latest']);
    if (!code || code === '0x' || keccak256(code).toLowerCase() !== token.runtimeCodeHash.toLowerCase()) throw Error('ENROLLMENT_TOKEN_CODE_MISMATCH');
    const raw = await rpc.request<`0x${string}`>('eth_call', [{ to: token.address, data: encodeFunctionData({ abi: decimalsAbi, functionName: 'decimals', args: [] }) }, 'latest']);
    const decimals = Number(decodeFunctionResult({ abi: decimalsAbi, functionName: 'decimals', data: raw }));
    if (decimals !== token.decimals) throw Error('ENROLLMENT_TOKEN_DECIMALS_MISMATCH');
    verified.push({ id: `enrollment-${manifest.chainId}-${token.address}`, ...token });
  }
  db.transaction(() => {
    db.query("UPDATE assets SET admission='blocked',admission_reason='removed_from_reviewed_enrollment_manifest' WHERE chain_id=? AND id LIKE 'enrollment-%'").run(manifest.chainId);
    for (const token of verified) {
      const existing = db.query('SELECT id FROM assets WHERE chain_id=? AND lower(address)=?').get(manifest.chainId, token.address.toLowerCase()) as { id: string } | null;
      if (existing && existing.id !== token.id) throw Error('ENROLLMENT_TOKEN_ASSET_CONFLICT');
      db.query(`INSERT INTO assets(id,provider,chain_id,address,symbol,name,decimals,legal_instrument_type,source_terms_version,capabilities_json,admission,admission_reason)
        VALUES(?,?,?,?,?,?,?,?,?,'["payment"]','allowed',NULL)
        ON CONFLICT(id) DO UPDATE SET provider=excluded.provider,address=excluded.address,symbol=excluded.symbol,name=excluded.name,decimals=excluded.decimals,source_terms_version=excluded.source_terms_version,admission='allowed',admission_reason=NULL`)
        .run(token.id,token.provider,manifest.chainId,token.address,token.symbol,token.name,token.decimals,'settlement_token',token.sourceTermsVersion);
    }
  })();
}
