import { expect, test } from 'bun:test';
import { parsePendingDeployment, pendingDeploymentKey } from '../src/lib/deploymentRecovery';

const parent = `0x${'1'.repeat(40)}`;
const factory = `0x${'2'.repeat(40)}`;
const hash = `0x${'3'.repeat(64)}` as `0x${string}`;
const saved = JSON.stringify({ chainId: 31337, parent, factory, hash });

test('a recovery hint is scoped to the exact chain, parent and reviewed factory', () => {
  expect(pendingDeploymentKey(31337, parent)).toContain(parent);
  expect(parsePendingDeployment(saved, 31337, parent, factory)?.hash).toBe(hash);
  expect(parsePendingDeployment(saved, 46630, parent, factory)).toBeUndefined();
  expect(parsePendingDeployment(saved, 31337, `0x${'4'.repeat(40)}`, factory)).toBeUndefined();
  expect(parsePendingDeployment(saved, 31337, parent, `0x${'5'.repeat(40)}`)).toBeUndefined();
  expect(parsePendingDeployment(JSON.stringify({ ...JSON.parse(saved), extra: 'trusted' }), 31337, parent, factory)).toBeUndefined();
  expect(parsePendingDeployment('{bad', 31337, parent, factory)).toBeUndefined();
});
