import { test, expect } from 'bun:test';
import { continuityCall } from './continuity';
import { managementCall } from './management';
const address='0x0000000000000000000000000000000000000001';
test('continuity allowlist rejects arbitrary targets and requires exact typed parameters',()=>{
 expect(()=>continuityCall({operation:'execute',to:address,data:'0x1234'})).toThrow();
 expect(()=>continuityCall({operation:'approveRecovery',id:'1',signature:'0x',target:address})).toThrow();
 expect(()=>continuityCall({operation:'requestSuccession',successor:address})).toThrow();
 expect(continuityCall({operation:'approveRecovery',id:'2'})).toEqual({target:'account',method:'approveRecovery',args:[2n]});
 expect(continuityCall({operation:'resolveIncapacity',id:'3',approved:false})).toEqual({target:'incapacity',method:'resolve',args:[3n,false]});
 expect(managementCall({operation:'queueIncapacityModule',module:address,caregiver:address,actionMask:'1',perActionLimit:'5'}).args).toEqual([address,address,1n,5n]);
});
