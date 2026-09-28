import { test, expect } from 'bun:test';
import { normalizeCatalog, normalizeSessions, sessionAllows } from './robinhood';
import { ReadRpcPool } from './rpc';
test('Robinhood flat and nested capability schemas fail closed independently',()=>{
  expect(normalizeSessions({market:{fractional:'TRADING_STATUS_TRADABLE'},extended:{fractional:null}})).toEqual({market:'tradable',extended:'unknown',overnight:'unknown'});
  expect(normalizeSessions({fractionalTradability:'position_closing_only',allDayTradability:'',extendedHoursFractionalTradability:true})).toEqual({market:'closing_only',extended:'closing_only',overnight:'unknown'});
  expect(sessionAllows('closing_only','BUY')).toBe(false);expect(sessionAllows('closing_only','SELL')).toBe(true);expect(sessionAllows('unknown','SELL')).toBe(false);
});
test('catalog keys chain/address, preserves raw multiplier, never infers eligibility',()=>{
  const raw={tokenSymbol:'AAPL',tokenName:'Apple',currentMultiplier:'1.00056',tokenDecimals:18,status:'ASSET_STATUS_ACTIVE',deployments:[{chainId:4663,contractAddress:'0x0000000000000000000000000000000000000123'}]};
  const [asset]=normalizeCatalog({assets:[raw]},4663);expect(asset!.eligibility).toBe('review-required');expect(asset!.multiplier).toBe('1.00056');expect(asset!.raw).toBe(raw);expect(normalizeCatalog({assets:[raw]},1)).toEqual([]);expect(()=>normalizeCatalog({assets:[raw,raw]},4663)).toThrow('PROVIDER_DUPLICATE_ASSET');
});
const h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`;
function mockRpc(options:{wrongChain?:boolean;disagree?:boolean;primaryDown?:boolean}) {
  return (async(url: string|URL|Request, init?:RequestInit)=>{
    const primary=String(url).includes('primary');if(primary&&options.primaryDown)throw Error('https://secret-key');
    const {method}=JSON.parse(String(init!.body));let result:unknown='0x01';
    if(method==='eth_chainId')result=options.wrongChain?'0x1':'0x7a69';
    if(method==='eth_getBlockByNumber')result={number:'0x5',hash:h(options.disagree&&!primary?2:1),parentHash:h(0),timestamp:'0x64'};
    return new Response(JSON.stringify({id:1,jsonrpc:'2.0',result}));
  }) as typeof fetch;
}
test('RPC rejects wrong-chain and disagreement, accepts healthy fallback, forbids send',async()=>{
  const urls=['https://primary.invalid/key','https://backup.invalid'];
  await expect(new ReadRpcPool(urls,31337,mockRpc({wrongChain:true}),()=>100000).request('eth_getCode')).rejects.toThrow('RPC_UNAVAILABLE');
  await expect(new ReadRpcPool(urls,31337,mockRpc({disagree:true}),()=>100000).request('eth_getCode')).rejects.toThrow('RPC_DISAGREEMENT');
  expect(await new ReadRpcPool(urls,31337,mockRpc({primaryDown:true}),()=>100000).request<string>('eth_getCode')).toBe('0x01');
  await expect(new ReadRpcPool(urls,31337,mockRpc({}),()=>100000).request('eth_sendRawTransaction')).rejects.toThrow('RPC_METHOD_NOT_ALLOWED');
});

import { createHmac } from 'node:crypto';
import { verifyEmailWebhook, createResendSender } from './notifications';
test('delivery proof requires authentic, recent, unaltered raw webhook',()=>{
  const secret=Buffer.alloc(32,7),body=JSON.stringify({type:'email.delivered',data:{email_id:'e1'}});
  const signature=createHmac('sha256',secret).update(`event1.1000.${body}`).digest('base64');
  const input={rawBody:body,id:'event1',timestamp:'1000',signatures:`v1,${signature}`,secret:`whsec_${secret.toString('base64')}`,nowSeconds:1000};
  expect(verifyEmailWebhook(input)).toEqual({eventId:'event1',providerId:'e1',delivered:true,failed:false});
  expect(()=>verifyEmailWebhook({...input,rawBody:body.replace('e1','e2')})).toThrow('INVALID_WEBHOOK');
  expect(()=>verifyEmailWebhook({...input,nowSeconds:1500})).toThrow('INVALID_WEBHOOK');
});
test('email adapter uses idempotency and does not leak provider response or key',async()=>{
  const send=createResendSender({apiKey:'test-key',from:'Steward <notify@example.test>',recipientForAccount:async()=> 'user@example.test',fetcher:(async(_url,init)=>{expect(new Headers(init!.headers).get('Idempotency-Key')).toBe('job1');return new Response('private provider response',{status:500});}) as typeof fetch});
  await expect(send({accountId:'a',idempotencyKey:'job1',subject:'Update',text:'Open app'})).rejects.toThrow('EMAIL_SEND_FAILED');
});
