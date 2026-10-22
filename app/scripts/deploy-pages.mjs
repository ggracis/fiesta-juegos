// Builds the static demo and force-pushes app/dist to the gh-pages branch.
// ponytail: branch deploy because the local gh token lacks the `workflow` scope;
// switch to the Actions workflow once `gh auth refresh -s workflow` is done.
import { execSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const app = resolve(import.meta.dirname, '..');
const dist = resolve(app, 'dist');
const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'inherit' });
const remote = execSync('git remote get-url origin', { cwd: app }).toString().trim();

run('npm run build:pages', app);
writeFileSync(resolve(dist, '.nojekyll'), '');
rmSync(resolve(dist, '.git'), { recursive: true, force: true });
run('git init -q -b gh-pages', dist);
run('git add -A', dist);
run('git commit -q -m "chore: deploy pilot build"', dist);
run(`git push -f -q ${remote} gh-pages`, dist);
rmSync(resolve(dist, '.git'), { recursive: true, force: true });
console.log('Deployed to gh-pages.');
