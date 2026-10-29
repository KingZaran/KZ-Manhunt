// Adds/updates ?v=<version> on the app's own CSS/JS links so phones never run a stale cached copy.
// Run after changing any file in js/ or css/: node tools/bump-version.mjs
import { readFileSync, writeFileSync } from 'node:fs';
const v = Date.now().toString(36);
const root = new URL('..', import.meta.url).pathname;
const files = ['index.html', 'js/app.js', 'js/fb.js'];
for (const f of files) {
  const p = root + f;
  const s = readFileSync(p, 'utf8')
    .replace(/((?:href|src)="(?:css|js)\/[\w-]+\.(?:css|js))(?:\?v=\w+)?"/g, `$1?v=${v}"`)
    .replace(/(from '\.\/[\w-]+\.js)(?:\?v=\w+)?'/g, `$1?v=${v}'`);
  writeFileSync(p, s);
}
console.log('version', v);
