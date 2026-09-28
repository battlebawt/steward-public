import { test,expect } from 'bun:test';
import { encodeEventTopics,encodeAbiParameters,parseAbi } from 'viem';
import { createDatabase } from '../db';
import { initIndexer } from './indexer';
import { rebuildTransactionProjections } from './projections';
const actionId=`0x${'01'.repeat(32)}` as const,hash=`0x${'02'.repeat(32)}`,account='0x0000000000000000000000000000000000000001';
const abi=parseAbi(['event ActionExecuted(bytes32 indexed actionId,uint8 indexed kind,address indexed actor,uint256 amountIn,uint256 amountOut)']);
test('canonical receipt projections bind account and action, then rewind orphaned execution',()=>{
 const db=createDatabase(':memory:');initIndexer(db);const now=new Date().toISOString();
 try{
 db.query('INSERT INTO users(id,wallet_address,created_at) VALUES (?,?,?)').run('u',account,now);
 db.query('INSERT INTO accounts(id,chain_id,address,parent_user_id,created_at) VALUES (?,?,?,?,?)').run('a',31337,account,'u',now);
 db.query('INSERT INTO intents(id,account_id,action_hash,actor_user_id,actor_address,action_json,state,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?)').run('i','a',actionId,'u',account,JSON.stringify({actionId}),'submitted',now,now);
 db.query('INSERT INTO transactions(id,intent_id,tx_hash,chain_id,state,observed_at) VALUES (?,?,?,?,?,?)').run('t','i',hash,31337,'submitted',now);
 db.query('INSERT INTO expenses(id,account_id,intent_id,amount_raw,token_address,state,created_by_user_id,created_at) VALUES (?,?,?,?,?,?,?,?)').run('e','a','i','1',account,'pending','u',now);
 const log={blockNumber:1,blockHash:'block1',transactionHash:hash,logIndex:0,address:'0x0000000000000000000000000000000000000002',topics:encodeEventTopics({abi,eventName:'ActionExecuted',args:{actionId,kind:0,actor:account}}),data:encodeAbiParameters([{type:'uint256'},{type:'uint256'}],[1n,1n])};
 db.query('INSERT INTO ops_chain_logs VALUES (?,?,?,?,?,?,?,?,?)').run(31337,1,'block1',hash,0,log.address,JSON.stringify(log),1,'finalized');
 rebuildTransactionProjections(db,31337);expect(db.query('SELECT state FROM intents').get()).toEqual({state:'submitted'});
 log.address=account;db.query('UPDATE ops_chain_logs SET address=?,payload=?').run(account,JSON.stringify(log));rebuildTransactionProjections(db,31337);expect(db.query('SELECT state FROM intents').get()).toEqual({state:'finalized'});expect(db.query('SELECT state FROM expenses').get()).toEqual({state:'paid_onchain'});
 db.query('UPDATE ops_chain_logs SET canonical=0').run();rebuildTransactionProjections(db,31337);expect(db.query('SELECT state FROM intents').get()).toEqual({state:'reorged'});expect(db.query('SELECT state FROM expenses').get()).toEqual({state:'pending'});
 }finally{db.close();}
});

test('failed duplicate submission cannot overwrite a separately finalized action',()=>{
 const db=createDatabase(':memory:');initIndexer(db);const now=new Date().toISOString();
 db.query('INSERT INTO users(id,wallet_address,created_at) VALUES(?,?,?)').run('u',account,now);
 db.query('INSERT INTO accounts(id,chain_id,address,parent_user_id,created_at) VALUES(?,?,?,?,?)').run('a',31337,account,'u',now);
 db.query('INSERT INTO intents(id,account_id,action_hash,actor_user_id,actor_address,action_json,state,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)').run('i','a',actionId,'u',account,JSON.stringify({actionId}),'finalized',now,now);
 for(const [id,state] of [['success','finalized'],['retry','reverted']])db.query('INSERT INTO transactions(id,intent_id,tx_hash,chain_id,state,observed_at) VALUES(?,?,?,?,?,?)').run(id!,'i',id!,31337,state!,now);
 rebuildTransactionProjections(db,31337);expect(db.query('SELECT state FROM intents').get()).toEqual({state:'finalized'});db.close();
});
