import type { Database } from 'bun:sqlite';
import { decodeEventLog, type Hex } from 'viem';
import { StewardAccountV1Abi } from '../integrations/contracts.generated';
import type { ChainLog } from './indexer';
/** Rebuild only transaction projections; signing permission is always checked freshly by the chain gateway. */
export function rebuildTransactionProjections(db: Database, chainId: number) {
  const logs=db.query('SELECT payload,finality FROM ops_chain_logs WHERE chain_id=? AND canonical=1 ORDER BY block_number,log_index').all(chainId) as {payload:string;finality:string}[];
  const observed=new Map<string,{address:string;actionId:string;state:string;blockHash:string;blockNumber:number}>();
  for(const row of logs){
    const log=JSON.parse(row.payload) as ChainLog;
    try {
      const event=decodeEventLog({abi:StewardAccountV1Abi,data:log.data as Hex,topics:log.topics as [Hex,...Hex[]]});
      if(event.eventName==='ActionExecuted')observed.set(log.transactionHash.toLowerCase(),{address:log.address.toLowerCase(),actionId:event.args.actionId,state:row.finality==='finalized'?'finalized':'included',blockHash:log.blockHash,blockNumber:log.blockNumber});
    }catch{/* Other contracts/events cannot establish an executed Steward action. */}
  }
  const rows=db.query('SELECT t.id,t.tx_hash,t.intent_id,t.state,i.action_json,a.address AS account_address FROM transactions t JOIN intents i ON i.id=t.intent_id JOIN accounts a ON a.id=i.account_id WHERE t.chain_id=?').all(chainId) as {id:string;tx_hash:string;intent_id:string;state:string;action_json:string;account_address:string}[];
  for(const row of rows){
    const event=observed.get(row.tx_hash.toLowerCase());
    if(event&&event.address===row.account_address.toLowerCase()&&event.actionId.toLowerCase()===JSON.parse(row.action_json).actionId.toLowerCase()){
      db.query('UPDATE transactions SET state=?,block_number=?,block_hash=?,observed_at=? WHERE id=?').run(event.state,String(event.blockNumber),event.blockHash,new Date().toISOString(),row.id);

    }else if(['included','finalized'].includes(row.state)){
      const orphan=db.query('SELECT 1 FROM ops_chain_logs WHERE chain_id=? AND tx_hash=? AND canonical=0 LIMIT 1').get(chainId,row.tx_hash.toLowerCase());
      if(orphan)db.query("UPDATE transactions SET state='reorged' WHERE id=?").run(row.id);
    }
  }
  for(const intentId of new Set(rows.map(r=>r.intent_id))){
    const states=(db.query('SELECT state FROM transactions WHERE intent_id=?').all(intentId) as {state:string}[]).map(r=>r.state);
    const state=['finalized','included','submitted','reorged','reverted'].find(v=>states.includes(v));
    if(state){db.query('UPDATE intents SET state=? WHERE id=?').run(state,intentId);db.query('UPDATE expenses SET state=? WHERE intent_id=?').run(['finalized','included'].includes(state)?'paid_onchain':'pending',intentId);}
  }

}
