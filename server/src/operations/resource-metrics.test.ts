import { test, expect } from 'bun:test';
import { parseCgroupMemoryStat } from './resource-metrics';

test('container resource sample separates anonymous memory from file cache without identifiers', () => {
  expect(parseCgroupMemoryStat('anon 104857600\nfile 209715200\nkernel 10485760\n')).toEqual({ cgroupAnonMB: 100, cgroupFileMB: 200, cgroupKernelMB: 10 });
  expect(parseCgroupMemoryStat('not a memory stat')).toEqual({});
});
