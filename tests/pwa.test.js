import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createInstaller } from '../src/pwa.js';

function installerFixture({ standalone = false, secure = true } = {}) {
  const listeners = new Map(); const changes = []; const registrations = [];
  const win = { isSecureContext: secure, addEventListener: (name, fn) => listeners.set(name, fn), matchMedia: () => ({ matches: standalone, addEventListener() {} }) };
  const nav = { serviceWorker: { async register(...args) { registrations.push(args); } } };
  return { controller: createInstaller({ win, nav, onChange: (state) => changes.push(state) }), listeners, changes, registrations };
}

test('installation requires a user action and a fresh browser prompt', async () => {
  const f = installerFixture(); let prompts = 0, prevented = false;
  f.listeners.get('beforeinstallprompt')({ preventDefault() { prevented = true; }, async prompt() { prompts++; }, userChoice: Promise.resolve({ outcome: 'dismissed' }) });
  assert.equal(prevented, true); assert.equal(prompts, 0); assert.equal(f.controller.state().available, true);
  assert.deepEqual(await f.controller.install(), { outcome: 'dismissed' });
  assert.equal(prompts, 1); assert.equal(f.controller.state().available, false);
  assert.deepEqual(await f.controller.install(), { outcome: 'help' });
  assert.equal(prompts, 1);
});

test('accepting a prompt is not reported as a completed installation until appinstalled', async () => {
  const f = installerFixture();
  f.listeners.get('beforeinstallprompt')({ preventDefault() {}, async prompt() {}, userChoice: Promise.resolve({ outcome: 'accepted' }) });
  await f.controller.install(); assert.equal(f.controller.state().installed, false);
  f.listeners.get('appinstalled')(); assert.equal(f.controller.state().installed, true);
  assert.deepEqual(await f.controller.install(), { outcome: 'installed' });
});

test('standalone apps do not offer duplicate installation', async () => {
  const f = installerFixture({ standalone: true });
  assert.deepEqual(await f.controller.install(), { outcome: 'installed' });
});

test('unavailable or failed install prompts provide a usable browser-menu fallback', async () => {
  const f = installerFixture();
  await f.controller.install(); assert.match(f.controller.state().message, /Chrome on Android/);
  f.listeners.get('beforeinstallprompt')({ preventDefault() {}, async prompt() { throw new Error('not allowed'); } });
  assert.deepEqual(await f.controller.install(), { outcome: 'help' });
  assert.equal(f.controller.state().installing, false);
});

test('service worker registration respects secure contexts', async () => {
  const insecure = installerFixture({ secure: false });
  assert.equal(await insecure.controller.register(), false); assert.equal(insecure.registrations.length, 0);
  const secure = installerFixture();
  assert.equal(await secure.controller.register(), true); assert.equal(secure.registrations.length, 1);
  assert.equal(secure.registrations[0][1].updateViaCache, 'none');
});

async function workerFixture() {
  const listeners = new Map(); const deleted = []; let claimed = false;
  const stored = new Map(); let precached = [];
  const cache = { async addAll(urls) { precached = urls; }, async match(request) { return stored.get(request.url); } };
  const caches = { async open() { return cache; }, async keys() { return ['fxc-shell:/:old', 'fxc-shell:/:test', 'fxc-shell:/other/:old', 'another-app']; }, async delete(key) { deleted.push(key); } };
  const self = { location: { href: 'https://fxc.test/sw.js' }, clients: { async claim() { claimed = true; } }, addEventListener: (name, fn) => listeners.set(name, fn) };
  const code = (await readFile(new URL('../src/service-worker.js', import.meta.url), 'utf8')).replace("'__FXC_RELEASE__'", "'test'").replace('__FXC_ASSETS__', JSON.stringify(['./', './index.html', './styles.css']));
  vm.runInNewContext(code, { self, caches, URL, Response, fetch: async () => { throw new Error('offline'); } });
  return { listeners, stored, deleted, get claimed() { return claimed; }, get precached() { return precached; } };
}

test('the worker never intercepts authentication, private APIs, queries, or mutations', async () => {
  const f = await workerFixture();
  const requests = [
    new Request('https://cvernmhpnsgdtegvblyc.supabase.co/auth/v1/token'),
    new Request('https://fxc.test/rest/v1/fxc_trades'),
    new Request('https://fxc.test/?code=private'),
    new Request('https://fxc.test/', { method: 'POST' }),
    new Request('https://fxc.test/index.html', { headers: { Authorization: 'Bearer private' } })
  ];
  for (const request of requests) {
    let intercepted = false;
    f.listeners.get('fetch')({ request, respondWith() { intercepted = true; } });
    assert.equal(intercepted, false, request.url);
  }
});

test('public app-shell resources remain available when offline', async () => {
  const f = await workerFixture(); const request = new Request('https://fxc.test/index.html');
  f.stored.set(request.url, new Response('offline shell'));
  let response;
  f.listeners.get('fetch')({ request, respondWith(promise) { response = promise; } });
  assert.equal(await (await response).text(), 'offline shell');
  let install;
  f.listeners.get('install')({ waitUntil(promise) { install = promise; } }); await install;
  assert.ok(f.precached.every((url) => url.startsWith('https://fxc.test/')));
});

test('activation removes only stale FXC caches in the same application scope', async () => {
  const f = await workerFixture(); let activation;
  f.listeners.get('activate')({ waitUntil(promise) { activation = promise; } }); await activation;
  assert.deepEqual(f.deleted, ['fxc-shell:/:old']); assert.equal(f.claimed, true);
});
