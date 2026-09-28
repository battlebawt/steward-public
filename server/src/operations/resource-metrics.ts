import { readFileSync } from 'node:fs';

const mb = (bytes: number) => Math.round(bytes / 1048576);

/** Linux cgroup v2 reports process memory and reclaimable file cache separately. */
export function parseCgroupMemoryStat(raw: string) {
  const values = new Map<string, number>();
  for (const line of raw.split('\n')) {
    const match = /^([a-z_]+) ([0-9]+)$/.exec(line);
    if (match) values.set(match[1]!, Number(match[2]));
  }
  const anon = values.get('anon'), file = values.get('file'), kernel = values.get('kernel');
  if (anon === undefined || file === undefined || kernel === undefined) return {};
  return { cgroupAnonMB: mb(anon), cgroupFileMB: mb(file), cgroupKernelMB: mb(kernel) };
}

export function resourceSample(stage: string) {
  const memory = process.memoryUsage();
  let cgroup = {};
  try { cgroup = parseCgroupMemoryStat(readFileSync('/sys/fs/cgroup/memory.stat', 'utf8')); } catch { /* local macOS probes lack cgroup v2 */ }
  console.log(JSON.stringify({ event: 'STEWARD_RESOURCE_SAMPLE', stage,
    rssMB: mb(memory.rss), heapMB: mb(memory.heapUsed), externalMB: mb(memory.external), ...cgroup }));
}
