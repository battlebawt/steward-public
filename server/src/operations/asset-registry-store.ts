import type {Database} from 'bun:sqlite';
import type {ObservedAssetRegistry} from '../integrations/asset-registry';
import {AddressSchema} from '@steward/shared';
/** Append-only observation history: changing a policy must not hide residual assets. */
export function sqliteAssetRegistry(db:Database,chainId:number):ObservedAssetRegistry{
 if(!Number.isSafeInteger(chainId)||chainId<=0)throw Error('INVALID_CHAIN_ID');
 db.exec('CREATE TABLE IF NOT EXISTS observed_account_assets(chain_id INTEGER NOT NULL,account_address TEXT NOT NULL,asset_address TEXT NOT NULL,first_observed_at TEXT NOT NULL,PRIMARY KEY(chain_id,account_address,asset_address))');
 return {
  remember:(account,assets)=>{const owner=AddressSchema.parse(account),tokens=assets.map(a=>AddressSchema.parse(a));db.transaction(()=>{const stmt=db.query('INSERT OR IGNORE INTO observed_account_assets VALUES(?,?,?,?)');for(const asset of tokens)stmt.run(chainId,owner,asset,new Date().toISOString());})();},
  list:account=>(db.query('SELECT asset_address FROM observed_account_assets WHERE chain_id=? AND account_address=? ORDER BY asset_address').all(chainId,AddressSchema.parse(account)) as {asset_address:`0x${string}`}[]).map(r=>r.asset_address)
 };
}
