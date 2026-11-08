import { cp, mkdir, rm } from 'node:fs/promises';
import './prepare.mjs';

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
for (const file of ['index.html', 'styles.css', 'favicon.svg', 'manifest.webmanifest', 'icons', 'sw.js', 'src', 'vendor']) {
  await cp(file, `dist/${file}`, { recursive: true });
}
console.log('Built static site in dist/');
