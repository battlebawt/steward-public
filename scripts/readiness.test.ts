import { test,expect } from 'bun:test';
import { checkReadiness } from './readiness';
test('unreviewed launch is blocked even if a chain id is supplied',async()=>{
 const errors=await checkReadiness({chainId:4663,assets:[],gates:{}});
 expect(errors.filter(e=>e.startsWith('G')).length).toBe(5);
 expect(errors).toContain('RPC: not checked');
});

test('a chain without a published sequencer feed may use an explicit zero-feed policy',async()=>{
 const base={chainId:4663,gates:{},assets:[{symbol:'fixture',token:'0x0000000000000000000000000000000000000003',feed:'0x0000000000000000000000000000000000000004',settlementFeed:'0x0000000000000000000000000000000000000005',adapter:'0x0000000000000000000000000000000000000007',maxPriceAge:3600,sequencerGrace:0,termsVersion:'reviewed',proxyReview:'reviewed'}]};
 const failures=await checkReadiness(base);
 expect(failures).not.toContain('asset fixture: sequencerFeed missing');
 expect(failures).not.toContain('asset fixture: timing configuration missing');
 expect(failures.some(e=>e.startsWith('G1_operating_market'))).toBe(true);
 expect(failures).toContain('asset fixture: no reviewed customer market');
 const invalid=await checkReadiness({...base,assets:[{...base.assets[0],sequencerGrace:3600}]});
 expect(invalid).toContain('asset fixture: timing configuration missing');
});

test('route review is scoped to its asset and market, without a global launch country',async()=>{
 const base={chainId:4663,gates:{},assets:[{symbol:'AAPL',issuer:'RHJ',markets:[{countryCode:'FR',approved:false,evidence:'',eligibilitySource:'',sessionSource:''}]}]};
 expect(await checkReadiness(base)).toContain('asset AAPL: FR market approval or live admission sources missing');
 const reviewed={...base.assets[0].markets[0],approved:true,evidence:'reviewed-market-evidence',eligibilitySource:'reviewed-account-source',sessionSource:'reviewed-session-source'};
 const withReview={...base,assets:[{...base.assets[0],markets:[reviewed]}]};
 expect(await checkReadiness(withReview)).not.toContain('asset AAPL: FR market approval or live admission sources missing');
 const us={...withReview,assets:[{...base.assets[0],markets:[{...reviewed,countryCode:'US'}]}]};
 expect(await checkReadiness(us)).toContain('asset AAPL: RHJ US is issuer-restricted');
 const differentIssuer={...withReview,assets:[{...base.assets[0],issuer:'independent-issuer',markets:[{...reviewed,countryCode:'US'}]}]};
 expect(await checkReadiness(differentIssuer)).not.toContain('asset AAPL: RHJ US is issuer-restricted');
});

test('readiness verifies implementation pointers and requires every route code pin at a finalized block',async()=>{
 const {ReadRpcPool}=await import('../server/src/integrations/rpc');const {keccak256,encodeAbiParameters,parseAbiParameters}=await import('viem');
 const a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as `0x${string}`;
 const hash=`0x${'11'.repeat(32)}`;let pointer=a(2);
 const rpc=new ReadRpcPool(['http://127.0.0.1:1'],31337);
 rpc.request=async(method:string,params:unknown[]=[])=>{
  if(method==='eth_chainId')return '0x7a69' as any;
  if(method==='eth_getBlockByNumber')return {number:'0xa',hash,timestamp:'0x64'} as any;
  if(method==='eth_getCode'){expect(params[1]).toBe('0xa');return '0x6000' as any;}
  if(method==='eth_call'){expect(params[1]).toBe('0xa');return encodeAbiParameters(parseAbiParameters('address'),[pointer]) as any;}
  throw Error('unexpected RPC');
 };
 const clone=`0x363d3d373d3d3d363d73${a(2).slice(2)}5af43d82803e903d91602b57fd5bf3` as `0x${string}`;
 const config={chainId:31337,factory:a(1),factoryCodeHash:keccak256('0x6000'),implementation:a(2),implementationCodeHash:keccak256('0x6000'),accountRuntimeCodeHash:keccak256(clone),gates:{},assets:[{symbol:'fixture',token:a(3),feed:a(4),settlementFeed:a(5),sequencerFeed:a(6),adapter:a(7),maxPriceAge:60,sequencerGrace:30,termsVersion:'fixture',proxyReview:'fixture'}]};
 let failures=await checkReadiness(config,rpc);
 expect(failures).toContain('asset fixture source: reviewed address/hash missing');expect(failures).toContain('asset fixture token: reviewed address/hash missing');expect(failures).not.toContain('factory: implementation pointer mismatch');
 pointer=a(9);failures=await checkReadiness(config,rpc);expect(failures).toContain('factory: implementation pointer mismatch');
});
