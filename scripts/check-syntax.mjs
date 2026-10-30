// `node --check` every JavaScript file of the extension and the scripts.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = join(import.meta.dirname, '..');
const files = [];
(function walk(d) {
  for (const f of readdirSync(d)) {
    if (f === 'node_modules' || f.startsWith('.')) continue;
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(m?js)$/.test(f)) files.push(p);
  }
})(root);
for (const f of files) execFileSync(process.execPath, ['--check', f], { stdio: 'inherit' });
console.log(`✓ syntax OK (${files.length} files)`);
