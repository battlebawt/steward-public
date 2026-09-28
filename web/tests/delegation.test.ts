import { expect, test } from 'bun:test';
import { buildDelegateRequest, buildRevokeDelegateRequest } from '../src/lib/delegation';

const parent='0x1000000000000000000000000000000000000001';
const caregiver='0x2000000000000000000000000000000000000002';

test('a guided grant binds selected powers, immediate expiry and an explicit account-limit choice',()=>{
  expect(buildDelegateRequest({delegate:caregiver,parent,permissions:['payment','sell'],expiresInDays:7,accountLimitsAcknowledged:true,nowSeconds:1000})).toEqual({operation:'setDelegate',delegate:caregiver,actionMask:'5',expiresAt:String(1000+7*86_400),perActionLimit:'0'});
  expect(()=>buildDelegateRequest({delegate:caregiver,parent,permissions:['payment'],expiresInDays:7,accountLimitsAcknowledged:false,nowSeconds:1000})).toThrow('Confirm');
  expect(()=>buildDelegateRequest({delegate:caregiver,parent,permissions:[],expiresInDays:7,accountLimitsAcknowledged:true,nowSeconds:1000})).toThrow('Choose');
  expect(()=>buildDelegateRequest({delegate:parent,parent,permissions:['payment'],expiresInDays:7,accountLimitsAcknowledged:true,nowSeconds:1000})).toThrow('parent');
  expect(()=>buildDelegateRequest({delegate:'0x0000000000000000000000000000000000000000',parent,permissions:['payment'],expiresInDays:7,accountLimitsAcknowledged:true,nowSeconds:1000})).toThrow('caregiver');
  expect(()=>buildDelegateRequest({delegate:caregiver,parent,permissions:['payment'],expiresInDays:90 as 7,accountLimitsAcknowledged:true,nowSeconds:1000})).toThrow('expiry');
  expect(buildRevokeDelegateRequest(caregiver)).toEqual({operation:'revokeDelegate',delegate:caregiver});
});
