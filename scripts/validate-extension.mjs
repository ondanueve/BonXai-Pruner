// Sanity checks for the unpacked extension in extension/:
// manifest parses, referenced files exist (incl. importScripts and <script src>),
// PNG icons have the declared size, description fits Chrome's 132-char limit,
// and no deprecated Prompt API namespace (window.ai / self.ai) is used.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(import.meta.dirname, '..', 'extension');
const errors = [];
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));

const referenced = new Set(
  [
    manifest.action?.default_popup,
    manifest.side_panel?.default_path,
    manifest.background?.service_worker,
    ...Object.values(manifest.icons ?? {}),
    ...Object.values(manifest.action?.default_icon ?? {}),
    ...(manifest.content_scripts ?? []).flatMap((c) => c.js ?? [])
  ].filter(Boolean)
);

const sw = manifest.background?.service_worker;
if (sw && existsSync(join(dir, sw))) {
  for (const m of readFileSync(join(dir, sw), 'utf8').matchAll(/importScripts\(([^)]*)\)/g)) {
    for (const f of m[1].matchAll(/'([^']+)'|"([^"]+)"/g)) referenced.add(f[1] || f[2]);
  }
}
for (const html of readdirSync(dir).filter((f) => f.endsWith('.html'))) {
  const src = readFileSync(join(dir, html), 'utf8');
  for (const m of src.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+)"/g)) {
    if (!/^https?:/.test(m[1])) referenced.add(m[1]);
  }
  if (/<script(?![^>]*\bsrc=)[^>]*>/.test(src)) errors.push(`${html} has an inline <script> (blocked by the extension CSP)`);
}

for (const file of referenced) {
  if (!existsSync(join(dir, file))) errors.push(`Missing referenced file: ${file}`);
}

for (const [size, file] of Object.entries(manifest.icons ?? {})) {
  const path = join(dir, file);
  if (!existsSync(path)) continue;
  const buf = readFileSync(path);
  const isPng = buf.subarray(1, 4).toString() === 'PNG';
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  if (!isPng || w !== Number(size) || h !== Number(size)) {
    errors.push(`Icon ${file} should be a ${size}x${size} PNG (got ${isPng ? `${w}x${h}` : 'non-PNG'})`);
  }
}

for (const file of [...referenced].filter((f) => f.endsWith('.js')).concat(['eval.js'])) {
  if (!existsSync(join(dir, file))) continue;
  const src = readFileSync(join(dir, file), 'utf8');
  if (/\b(window|self)\.ai\b/.test(src)) errors.push(`${file} uses the deprecated window.ai / self.ai namespace`);
}

if (manifest.manifest_version !== 3) errors.push('manifest_version must be 3');
if ((manifest.description || '').length > 132) errors.push(`description is ${manifest.description.length} chars (max 132)`);

try {
  JSON.parse(readFileSync(join(dir, 'eval', 'dataset.json'), 'utf8'));
} catch (err) {
  errors.push(`eval/dataset.json is not valid JSON: ${err.message}`);
}

if (errors.length) {
  console.error(errors.map((e) => `✗ ${e}`).join('\n'));
  process.exit(1);
}
console.log(`✓ extension/ OK (${referenced.size} referenced files, manifest v${manifest.version})`);
