import { describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { buildPlan, ARTIFACTS } from './deployment-plan';

const DEPLOYER = '0x1111111111111111111111111111111111111111';
const RP_HASH = `0x${'11'.repeat(32)}`;
const P256_X = '0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296';
const P256_Y = '0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5';
const PASSKEY = { rpIdHash: RP_HASH, origin: 'https://pilot.example', publicKeyX: P256_X, publicKeyY: P256_Y, enrolledEpoch: '1' };

const factory = (extra: Record<string, unknown> = {}) => ({ chainId: 4663, deployer: DEPLOYER, nonce: '7', contract: 'factory', ...extra });
const passkey = (extra: Record<string, unknown> = {}) => ({ chainId: 4663, deployer: DEPLOYER, nonce: '7', contract: 'passkey', passkey: PASSKEY, ...extra });

describe('unsigned deployment planner', () => {
  test('builds a factory plan containing the current deployable account', async () => {
    const plan=await buildPlan(factory());
    expect(plan.embeddedAccount?.runtimeByteLength).toBeLessThanOrEqual(24576);
    expect(plan.embeddedAccount?.embeddedInFactoryCreation).toBe(true);
    expect(plan.transaction.to).toBeNull();
  });

  test('rejects oversized embedded account artifacts', async () => {
    const root=await mkdtemp(join(tmpdir(),'steward-size-'));
    try {
      // Copy only public source inputs needed by compiler metadata validation.
      await cp('contracts/src',join(root,'contracts/src'),{recursive:true});
      await cp('contracts/lib',join(root,'contracts/lib'),{recursive:true});
      for(const path of [ARTIFACTS.factory,ARTIFACTS.account]){
        const artifact=JSON.parse(await readFile(path,'utf8'));
        if(path===ARTIFACTS.account)artifact.deployedBytecode.object='0x'+'00'.repeat(24577);
        await mkdir(dirname(join(root,path)),{recursive:true});
        await writeFile(join(root,path),JSON.stringify(artifact));
      }
      await expect(buildPlan(factory(),root)).rejects.toThrow(/embedded account runtime bytecode .* exceeds EIP-170/);
    } finally { await rm(root,{recursive:true,force:true}); }
  });

  test('builds a valid passkey plan with exact constructor values', async () => {
    const plan = await buildPlan(passkey());
    expect(plan.contract).toBe('passkey');
    expect(plan.mode).toBe('public');
    expect(plan.constructorArgs).toHaveLength(5);
    expect(plan.constructorArgs[1]).toBe(PASSKEY.origin);
    expect(plan.constructorArgs[4]).toBe(1n);
  });

  test('allows explicit local Anvil rehearsal chain ID', async () => {
    const plan = await buildPlan(passkey({ chainId: 31337, mode: 'local-rehearsal' }));
    expect(plan.chainId).toBe(31337);
    expect(plan.mode).toBe('local-rehearsal');
  });

  test('rejects unknown fields, invalid modes, unsafe chain IDs and omitted nonce', async () => {
    await expect(buildPlan(factory({ extra: true }))).rejects.toThrow('not allowed');
    await expect(buildPlan(factory({ passkey: PASSKEY }))).rejects.toThrow('only valid');
    await expect(buildPlan(factory({ chainId: 0 }))).rejects.toThrow('safe positive');
    await expect(buildPlan(factory({ chainId: 31337 }))).rejects.toThrow('local-rehearsal');
    await expect(buildPlan(factory({ mode: 'local-rehearsal' }))).rejects.toThrow('requires chainId 31337');
    await expect(buildPlan({ chainId: 4663, deployer: DEPLOYER, contract: 'factory' })).rejects.toThrow('nonce');
  });

  test('rejects passkey unknown fields, paths, zero epoch, and invalid points', async () => {
    await expect(buildPlan(passkey({ passkey: { ...PASSKEY, extra: true } }))).rejects.toThrow('not allowed');
    await expect(buildPlan(passkey({ passkey: { ...PASSKEY, origin: 'https://pilot.example/path' } }))).rejects.toThrow('canonical');
    await expect(buildPlan(passkey({ passkey: { ...PASSKEY, enrolledEpoch: '0' } }))).rejects.toThrow('greater than zero');
    await expect(buildPlan(passkey({ passkey: { ...PASSKEY, origin: 'http://localhost:5173' } }))).rejects.toThrow('canonical');
    await expect(buildPlan(passkey({ passkey: { ...PASSKEY, publicKeyX: `0x${'01'.repeat(32)}`, publicKeyY: `0x${'02'.repeat(32)}` } }))).rejects.toThrow('valid P-256');
  });
});
