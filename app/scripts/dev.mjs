// Runs the API server and the Vite dev server together (Vite proxies /api to :3000).
import { spawn } from 'node:child_process';

const run = (cmd, args) => spawn(cmd, args, { stdio: 'inherit', shell: true, env: { ...process.env, PORT: '3000' } });
const kids = [run('node', ['server/index.ts']), run('npx', ['vite'])];
for (const k of kids) k.on('exit', () => { kids.forEach((x) => x.kill()); process.exit(); });
