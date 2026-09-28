import { z } from 'zod';
import { ValuationSourceSchema } from './valuation';
import { AddressSchema } from '@steward/shared';
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(v => v.toLowerCase() as `0x${string}`);
const uint = z.string().regex(/^(0|[1-9][0-9]*)$/).max(78);
const account = z.object({ address: AddressSchema, runtimeCodeHash: hash, settlement: AddressSchema, deploymentBlock: uint, implementation: AddressSchema.optional(), implementationCodeHash: hash.optional(), accountVersion: z.literal('v2').optional() }).strict().refine(v => !!v.implementation === !!v.implementationCodeHash, 'Implementation address and code hash must be paired');
const factoryV2 = z.object({ address: AddressSchema, runtimeCodeHash: hash, accountRuntimeCodeHash: hash, v1Implementation: AddressSchema, v1ImplementationCodeHash: hash, cowModule: AddressSchema, cowModuleCodeHash: hash, settlement: AddressSchema, settlementCodeHash: hash, stockToken: AddressSchema, stockTokenCodeHash: hash, priceGuard: AddressSchema, priceGuardCodeHash: hash, relayer: AddressSchema, relayerCodeHash: hash, maxFeeBps: uint }).strict();
export const LiveManifestSchema = z.object({
  chainId: z.number().int().positive().safe(), version: z.string().min(1).max(100),
  accounts: z.array(account).max(10000),
  routes: z.array(z.object({ asset: AddressSchema, provider: z.string().min(1).max(80), legalInstrumentType: z.string().min(1).max(80), sourceTermsVersion: z.string().min(1).max(100), adapter: AddressSchema, adapterCodeHash: hash, quoter: AddressSchema, fee: z.number().int().min(1).max(1000000), session: z.enum(['market','extended','overnight']) }).strict()).max(1000),
  enrollmentTokens: z.array(z.object({ address: AddressSchema, runtimeCodeHash: hash, symbol: z.string().min(1).max(32), name: z.string().min(1).max(200), decimals: z.number().int().min(0).max(255), provider: z.string().min(1).max(80), sourceTermsVersion: z.string().min(1).max(100) }).strict()).max(32).optional(),
  valuationSources: z.array(ValuationSourceSchema).max(1000).optional(),
  incapacityModules: z.array(z.object({ account: AddressSchema, address: AddressSchema, runtimeCodeHash: hash }).strict()).max(10000).optional(),
  factory: z.object({ address: AddressSchema, runtimeCodeHash: hash, implementation: AddressSchema, implementationCodeHash: hash }).strict().optional(),
  factoryV2: factoryV2.optional(),
}).strict().superRefine((v,ctx) => {
  for (const [name, values] of [['accounts',v.accounts.map(a=>a.address)],['valuationSources',(v.valuationSources??[]).map(a=>a.asset)],['routes',v.routes.map(r=>r.asset)],['incapacityModules',(v.incapacityModules??[]).map(m=>m.account)],['enrollmentTokens',(v.enrollmentTokens??[]).map(t=>t.address)]] as const) {
    if(new Set(values.map(s=>s.toLowerCase())).size!==values.length)ctx.addIssue({code:'custom',path:[name],message:'Duplicate manifest entry'});
  }
});
