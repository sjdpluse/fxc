import test from 'node:test';
import assert from 'node:assert/strict';
import { createTradeId, dailyTotals, demoJournal, isDateKey, monthGrid, netOf, newJournal, parseMoney, shiftMonth, summarize, todayKey, validateJournal } from '../src/domain.js';
import { STORAGE_KEY, loadJournal, mergeJournals, saveJournal } from '../src/storage.js';

const trade = (overrides = {}) => ({ id: 'trade_1', date: '2026-11-08', symbol: 'XAUUSD', direction: 'long', grossCents: 25000, feeCents: 500, notes: '', ...overrides });
const journal = (trades = []) => ({ ...newJournal(), trades });
function memoryStorage() {
  const entries = new Map();
  return { getItem: (key) => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value) };
}

test('trade IDs work on HTTP previews without randomUUID using cryptographic random bytes', () => {
  const id = createTradeId({ getRandomValues(bytes) { bytes.fill(15); return bytes; } });
  assert.equal(id, '0f'.repeat(16));
  assert.equal(createTradeId({ randomUUID: () => 'uuid-test' }), 'uuid-test');
});

test('money is exact to the cent and rejects invalid or excessive precision', () => {
  assert.equal(parseMoney('0.29') + parseMoney('0.01'), 30);
  assert.equal(parseMoney('-105.09'), -10509);
  assert.equal(parseMoney('+100'), 10000);
  assert.equal(parseMoney('1000000000'), 100000000000);
  assert.equal(parseMoney('-0.00'), 0);
  for (const amount of ['1.001', 'NaN', 'Infinity', '1e3', '1,000', '', '1000000001', '--3']) assert.throws(() => parseMoney(amount));
  assert.throws(() => parseMoney('-1', { nonnegative: true }));
});

test('a day reflects the combined net result, including fees, rather than its last trade', () => {
  const trades = [trade(), trade({ id: 't2', grossCents: -30000, feeCents: 200 }), trade({ id: 't3', date: '2026-11-09', grossCents: 10000, feeCents: 10000 })];
  const totals = dailyTotals(trades);
  assert.equal(totals.get('2026-11-08').net, -5700);
  assert.equal(totals.get('2026-11-08').count, 2);
  assert.equal(totals.get('2026-11-09').net, 0);
  assert.equal(totals.get('2026-11-09').count, 1);
  assert.equal(totals.has('2026-11-10'), false);
  assert.equal(netOf(trade({ grossCents: 200, feeCents: 500 })), -300);
});

test('statistics count breakeven trades and handle zero loss without NaN', () => {
  assert.deepEqual(summarize([]), { net: 0, count: 0, wins: 0, losses: 0, flat: 0, days: 0, winRate: 0, profitFactor: null });
  const stats = summarize([trade({ grossCents: 20500 }), trade({ id: 'b', grossCents: -9500 }), trade({ id: 'c', grossCents: 500 })]);
  assert.equal(stats.net, 10000); assert.equal(stats.wins, 1); assert.equal(stats.losses, 1); assert.equal(stats.flat, 1);
  assert.ok(Math.abs(stats.winRate - 100 / 3) < 1e-10); assert.equal(stats.profitFactor, 2); assert.equal(stats.days, 1);
  assert.equal(summarize([trade()]).profitFactor, Infinity);
});

test('dates validate real Gregorian days and use the configured journal timezone', () => {
  assert.equal(isDateKey('2024-02-29'), true);
  for (const date of ['2026-02-29', '2026-04-31', '2026-00-01', '2026-11-8', '2101-01-01']) assert.equal(isDateKey(date), false);
  const now = new Date('2026-11-08T20:00:00Z');
  assert.equal(todayKey('Asia/Kabul', now), '2026-11-09');
  assert.equal(todayKey('America/New_York', now), '2026-11-08');
});

test('calendar covers complete Monday–Sunday weeks through leap years and year boundaries', () => {
  for (const month of ['2024-02', '2026-02', '2026-03', '2026-11', '2026-12', '2027-01']) {
    const grid = monthGrid(month);
    assert.equal(grid.length % 7, 0);
    assert.equal(new Date(grid[0].date + 'T12:00:00Z').getUTCDay(), 1);
    assert.equal(new Date(grid.at(-1).date + 'T12:00:00Z').getUTCDay(), 0);
    assert.equal(new Set(grid.map((d) => d.date)).size, grid.length);
  }
  assert.equal(monthGrid('2024-02').filter((d) => d.inMonth).length, 29);
  assert.equal(monthGrid('2026-03').length, 42);
  assert.equal(shiftMonth('2026-12', 1), '2027-01');
  assert.equal(shiftMonth('1900-01', -1), '1900-01');
  assert.equal(shiftMonth('2100-12', 1), '2100-12');
});

test('backup validation rejects duplicate IDs, malformed data and invalid timezones', () => {
  const valid = journal([trade()]);
  assert.deepEqual(validateJournal(JSON.parse(JSON.stringify(valid))), valid);
  for (const broken of [
    { ...valid, version: 2 }, journal([trade(), trade()]), journal([trade({ date: '2026-02-30' })]),
    journal([trade({ grossCents: 1.5 })]), journal([trade({ feeCents: -1 })]),
    journal([trade({ symbol: '<script>' })]), journal([trade({ direction: 'sideways' })]),
    journal([trade({ notes: 'x'.repeat(2001) })]), { ...valid, settings: { timeZone: 'Not/AZone' } }
  ]) assert.throws(() => validateJournal(broken));
});

test('storage persists exact records and never silently overwrites a corrupt journal', () => {
  const storage = memoryStorage();
  const original = journal([trade({ notes: 'Keep <this> & "that"' })]);
  saveJournal(original, storage);
  assert.deepEqual(loadJournal(storage).journal, original);
  storage.setItem(STORAGE_KEY, '{bad json');
  const loaded = loadJournal(storage);
  assert.equal(loaded.writable, false);
  assert.ok(loaded.error);
  assert.equal(storage.getItem(STORAGE_KEY), '{bad json');
  assert.equal(loadJournal({ getItem() { throw new Error('blocked'); } }).writable, false);
  assert.throws(() => saveJournal(original, { setItem() { throw new Error('full'); } }));
});

test('merging a backup is idempotent and conflicting edits require an explicit replacement', () => {
  const current = journal([trade()]);
  const incoming = journal([trade(), trade({ id: 'trade_2', symbol: 'US100' })]);
  const merged = mergeJournals(current, incoming);
  assert.equal(merged.added, 1); assert.equal(merged.unchanged, 1); assert.equal(merged.journal.trades.length, 2);
  const twice = mergeJournals(merged.journal, incoming);
  assert.equal(twice.added, 0); assert.equal(twice.unchanged, 2);
  assert.throws(() => mergeJournals(current, journal([trade({ grossCents: 1 })])));
  assert.equal(current.trades.length, 1);
});

test('demo data validates without mutating an empty personal journal', () => {
  const personal = newJournal();
  const demo = validateJournal(demoJournal('2026-11'));
  assert.ok(demo.trades.length > 0);
  assert.ok(demo.trades.every((t) => t.date.startsWith('2026-11')));
  assert.equal(personal.trades.length, 0);
  assert.ok([...dailyTotals(demo.trades).values()].some((d) => d.net < 0));
});
