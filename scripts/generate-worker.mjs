import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';

export async function generateWorker() {
  const source = (await readdir('src')).filter((file) => file.endsWith('.js') && file !== 'service-worker.js').sort().map((file) => `./src/${file}`);
  const icons = (await readdir('icons')).filter((file) => file.endsWith('.png')).sort().map((file) => `./icons/${file}`);
  const paths = ['./', './index.html', './styles.css', './favicon.svg', './manifest.webmanifest', './vendor/supabase.js', ...source, ...icons];
  const template = await readFile('src/service-worker.js', 'utf8');
  const digest = createHash('sha256').update(template);
  for (const path of paths.filter((p) => p !== './')) { digest.update(path); digest.update(await readFile(path)); }
  const worker = template.replace("'__FXC_RELEASE__'", JSON.stringify(digest.digest('hex').slice(0, 20))).replace('__FXC_ASSETS__', JSON.stringify(paths));
  await writeFile('sw.js', worker);
}
