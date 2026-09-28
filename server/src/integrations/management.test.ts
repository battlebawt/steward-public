import { test,expect } from 'bun:test';
import { managementCall,contractPolicy } from './management';
const address='0x0000000000000000000000000000000000000001';
test('management preparation never accepts arbitrary execution or extra target data',()=>{
 expect(()=>managementCall({operation:'execute',to:address,data:'0x'})).toThrow();
 expect(()=>managementCall({operation:'revokeDelegate',delegate:address,data:'0xdeadbeef'})).toThrow();
 expect(()=>managementCall({operation:'setDelegate',delegate:address,actionMask:'1',expiresAt:'18446744073709551616',perActionLimit:'1'})).toThrow();
 expect(()=>managementCall({operation:'executeDelegateExpansion'})).toThrow('UNSUPPORTED_MANAGEMENT_OPERATION');
 expect(managementCall({operation:'setDelegate',delegate:address,actionMask:'1',expiresAt:'2000000000',perActionLimit:'5'})).toEqual({method:'setDelegate',args:[address,1n,2000000000n,5n]});
 expect(managementCall({operation:'revokeDelegate',delegate:address})).toEqual({method:'revokeDelegate',args:[address]});
});
test('full policy preserves large raw amounts without numeric coercion',()=>{
 const huge='900719925474099312345';
 const config={settlement:address,period:'86400',anchor:'0',paymentLimit:huge,buyLimit:'0',reserve:'0',perPayment:huge,perBuy:'0',perSell:'0',exceptionQuorum:'2',approvedTokens:[],paymentRecipients:[address],exceptionSigners:[address],guardians:[address],approvedAdapters:[],sellCapTokens:[],sellCaps:[],continuityReviewer:address,continuitySuccessor:address,continuityPlanHash:`0x${'00'.repeat(32)}`};
 expect(contractPolicy(config).paymentLimit).toBe(BigInt(huge));
 expect(()=>contractPolicy({...config,paymentLimit:Number(huge)})).toThrow();
});
