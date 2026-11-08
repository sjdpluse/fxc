import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudJournalStore, parseCloudRecord } from '../src/cloud-store.js';
import { newJournal } from '../src/domain.js';

function fixtureClient() {
  let record = { revision: 0, journal: newJournal() };
  const calls = [];
  return { calls, get record() { return structuredClone(record); }, async rpc(name, args) {
    calls.push({ name, args });
    if (name === 'fxc_load_journal') return { data: structuredClone(record), error: null };
    if (args.p_expected_revision !== record.revision) return { error: { code: '40001', message: 'FXC_CONFLICT' }, data: null };
    record = { revision: record.revision + 1, journal: structuredClone(args.p_journal) };
    return { data: structuredClone(record), error: null };
  } };
}

test('cloud data is fully validated before it becomes a journal', () => {
  assert.throws(() => parseCloudRecord({ revision: -1, journal: newJournal() }));
  assert.throws(() => parseCloudRecord({ revision: 1.5, journal: newJournal() }));
  assert.throws(() => parseCloudRecord({ revision: 1, journal: { version: 99, trades: [] } }));
});

test('signed-out and not-yet-loaded clients cannot write', async () => {
  const client = fixtureClient(); const store = new CloudJournalStore(client);
  await assert.rejects(store.save(newJournal()), /Sign in/);
  store.setUser('user-a');
  await assert.rejects(store.save(newJournal()), /Refresh/);
  assert.equal(client.calls.length, 0);
});

test('a cloud save uses the loaded revision and requires an acknowledged next revision', async () => {
  const client = fixtureClient(); const store = new CloudJournalStore(client);
  store.setUser('user-a'); await store.load();
  const next = { ...newJournal(), settings: { timeZone: 'America/New_York' } };
  assert.deepEqual(await store.save(next), next);
  assert.equal(store.revision, 1);
  assert.deepEqual(client.calls.at(-1), { name: 'fxc_save_journal', args: { p_expected_revision: 0, p_journal: next } });
});

test('two devices cannot silently overwrite each other', async () => {
  const client = fixtureClient(); const a = new CloudJournalStore(client), b = new CloudJournalStore(client);
  a.setUser('user-a'); b.setUser('user-a'); await a.load(); await b.load();
  await a.save({ ...newJournal(), settings: { timeZone: 'Europe/London' } });
  await assert.rejects(b.save(newJournal()), /Another device/);
  assert.equal(b.revision, null);
  assert.equal(client.record.journal.settings.timeZone, 'Europe/London');
  await assert.rejects(b.save(newJournal()), /Refresh/);
  await b.load(); await b.save(newJournal()); assert.equal(b.revision, 2);
});

test('an uncertain network write cannot be blindly retried', async () => {
  const client = fixtureClient(); const store = new CloudJournalStore(client);
  store.setUser('user-a'); await store.load();
  client.rpc = async () => { throw new Error('connection lost'); };
  await assert.rejects(store.save(newJournal()), /not confirmed/);
  assert.equal(store.revision, null);
  await assert.rejects(store.save(newJournal()), /Refresh/);
});

test('an in-flight response from a previous account is discarded', async () => {
  let resolve;
  const client = { rpc: () => new Promise((done) => { resolve = done; }) };
  const store = new CloudJournalStore(client); store.setUser('user-a');
  const loading = store.load(); store.setUser('user-b');
  resolve({ data: { revision: 9, journal: newJournal() }, error: null });
  await assert.rejects(loading, /Account changed/);
  assert.equal(store.revision, null); assert.equal(store.userId, 'user-b');
});

test('changing or signing out of an account clears its revision', async () => {
  const store = new CloudJournalStore(fixtureClient()); store.setUser('user-a'); await store.load();
  store.setUser('user-b'); assert.equal(store.revision, null);
  await store.load(); store.setUser(null);
  assert.equal(store.revision, null); assert.equal(store.userId, null);
});

test('simultaneous saves are rejected instead of racing the same revision', async () => {
  const client = fixtureClient(); const store = new CloudJournalStore(client);
  store.setUser('user-a'); await store.load();
  let resolve; client.rpc = () => new Promise((done) => { resolve = done; });
  const saving = store.save(newJournal());
  await assert.rejects(store.save(newJournal()), /in progress/);
  resolve({ data: { revision: 1, journal: newJournal() }, error: null });
  await saving; assert.equal(store.revision, 1);
});
