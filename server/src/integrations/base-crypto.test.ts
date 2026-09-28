import { expect, test } from 'bun:test';
import { BaseCryptoCatalog } from './base-crypto';

test('Base cbBTC identity is pinned without granting account admission', async () => {
  expect(await new BaseCryptoCatalog(4663).assets()).toEqual([]);
  const [asset] = await new BaseCryptoCatalog(8453).assets();
  expect(asset?.address).toBe('0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf');
  expect(asset?.chainId).toBe(8453);
  expect(asset?.decimals).toBe(8);
  expect(asset?.eligibility).toBe('review-required');
  expect(asset?.sessions.market).toBe('tradable');
});
