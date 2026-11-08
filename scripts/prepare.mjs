import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { generateWorker } from './generate-worker.mjs';

await mkdir('vendor', { recursive: true });
await build({ stdin: { contents: "export { createClient } from '@supabase/supabase-js';", resolveDir: process.cwd(), sourcefile: 'supabase-client.js' }, outfile: 'vendor/supabase.js', bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, legalComments: 'eof' });
await generateWorker();
