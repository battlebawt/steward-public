/** Local demo only. No real wallets, keys, RPC credentials or funds are required. */
import { mkdirSync } from 'node:fs';
mkdirSync('data', { recursive: true });
const server = Bun.spawn(['bun', '--watch', 'server/src/index.ts'], { env: { ...process.env, STEWARD_MODE: 'demo', DEMO_MODE: 'true', PORT: '3000', ORIGIN: 'http://localhost:5173', DATABASE_PATH: 'data/steward-demo.sqlite' }, stdout: 'inherit', stderr: 'inherit' });
const web = Bun.spawn(['bun', 'run', '--cwd', 'web', 'dev', '--host', 'localhost'], { stdout: 'inherit', stderr: 'inherit' });
const stop = () => { server.kill(); web.kill(); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
const code = await Promise.race([server.exited, web.exited]); stop(); process.exit(code);
