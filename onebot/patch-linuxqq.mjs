import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [packageJsonPath, napcatDir] = process.argv.slice(2);
if (!packageJsonPath || !napcatDir) {
  throw new Error('Usage: node patch-linuxqq.mjs <QQ package.json> <NapCat directory>');
}

const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
packageJson.main = './loadNapCat.js';
fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

const loaderPath = path.join(path.dirname(packageJsonPath), 'loadNapCat.js');
const entryUrl = pathToFileURL(path.join(napcatDir, 'napcat.mjs')).href;
fs.writeFileSync(loaderPath, `(async () => { await import(${JSON.stringify(entryUrl)}); })();\n`);

console.log(`LinuxQQ patched to load NapCat from ${napcatDir}`);
