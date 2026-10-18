// Load the extension's classic-script libraries (extension/lib/*.js) into this
// Node process, the same way the browser does, and return globalThis.BonXai.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

export const EXT_DIR = join(import.meta.dirname, '..', 'extension');

export function loadLibs(names = ['rules', 'classifier', 'providers', 'metrics']) {
  for (const name of names) {
    const file = join(EXT_DIR, 'lib', `${name}.js`);
    vm.runInThisContext(readFileSync(file, 'utf8'), { filename: file });
  }
  return globalThis.BonXai;
}

export function readDataset() {
  return JSON.parse(readFileSync(join(EXT_DIR, 'eval', 'dataset.json'), 'utf8'));
}
