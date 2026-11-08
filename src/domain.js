export const SCHEMA_VERSION = 1;
export const MAX_TRADES = 10000;
const MAX_CENTS = 100_000_000_000;

export function createTradeId(random = globalThis.crypto) {
  if (typeof random.randomUUID === 'function') return random.randomUUID();
  return Array.from(random.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function isDateKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1900 || year > 2100) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function todayKey(timeZone = 'Asia/Kabul', now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function parseMoney(value, { nonnegative = false } = {}) {
  const text = String(value).trim();
  if (!/^[+-]?\d+(?:\.\d{1,2})?$/.test(text)) throw new Error('Enter a valid amount with up to two decimal places.');
  const negative = text.startsWith('-');
  const [whole, decimal = ''] = text.replace(/^[+-]/, '').split('.');
  const cents = (Number(whole) * 100 + Number(decimal.padEnd(2, '0'))) * (negative ? -1 : 1);
  if (!Number.isSafeInteger(cents) || Math.abs(cents) > MAX_CENTS) throw new Error('Amount must be $1,000,000,000 or less.');
  if (nonnegative && cents < 0) throw new Error('Fees cannot be negative.');
  return cents === 0 ? 0 : cents;
}

export function netOf(trade) { return trade.grossCents - trade.feeCents; }

export function summarize(trades) {
  let net = 0, wins = 0, losses = 0, positive = 0, negative = 0;
  const days = new Set();
  for (const trade of trades) {
    const result = netOf(trade);
    net += result;
    days.add(trade.date);
    if (result > 0) { wins++; positive += result; }
    if (result < 0) { losses++; negative -= result; }
  }
  return { net, count: trades.length, wins, losses, flat: trades.length - wins - losses, days: days.size,
    winRate: trades.length ? wins / trades.length * 100 : 0,
    profitFactor: negative ? positive / negative : positive ? Infinity : null };
}

export function dailyTotals(trades) {
  const map = new Map();
  for (const trade of trades) {
    const day = map.get(trade.date) || { date: trade.date, net: 0, count: 0, symbols: new Set() };
    day.net += netOf(trade); day.count++; day.symbols.add(trade.symbol); map.set(trade.date, day);
  }
  return map;
}

export function monthGrid(monthKey) {
  if (!isDateKey(`${monthKey}-01`)) throw new Error('Invalid month.');
  const [year, month] = monthKey.split('-').map(Number);
  const first = new Date(Date.UTC(year, month - 1, 1));
  const offset = (first.getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const length = Math.ceil((offset + days) / 7) * 7;
  return Array.from({ length }, (_, index) => {
    const d = new Date(Date.UTC(year, month - 1, index - offset + 1));
    return { date: d.toISOString().slice(0, 10), inMonth: index >= offset && index < offset + days };
  });
}

export function shiftMonth(monthKey, amount) {
  const [year, month] = monthKey.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1 + amount, 1));
  if (next.getUTCFullYear() < 1900 || next.getUTCFullYear() > 2100) return monthKey;
  return next.toISOString().slice(0, 7);
}

export function validateJournal(input) {
  if (!input || typeof input !== 'object' || input.version !== SCHEMA_VERSION || !Array.isArray(input.trades)) throw new Error('This file is not a supported FXC backup.');
  if (input.trades.length > MAX_TRADES) throw new Error(`A journal supports up to ${MAX_TRADES.toLocaleString('en-US')} trades.`);
  const ids = new Set();
  const trades = input.trades.map((t) => {
    if (!t || typeof t.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(t.id) || ids.has(t.id)) throw new Error('Backup contains an invalid or duplicate trade ID.');
    ids.add(t.id);
    if (!isDateKey(t.date)) throw new Error('Backup contains an invalid trade date.');
    if (typeof t.symbol !== 'string' || !/^[A-Z0-9][A-Z0-9 ./_-]{0,19}$/.test(t.symbol)) throw new Error('Backup contains an invalid instrument.');
    if (!['long', 'short'].includes(t.direction)) throw new Error('Backup contains an invalid direction.');
    if (!Number.isSafeInteger(t.grossCents) || Math.abs(t.grossCents) > MAX_CENTS || !Number.isSafeInteger(t.feeCents) || t.feeCents < 0 || t.feeCents > MAX_CENTS) throw new Error('Backup contains an invalid amount.');
    if (typeof t.notes !== 'string' || t.notes.length > 2000) throw new Error('Trade notes must be 2,000 characters or less.');
    return { id: t.id, date: t.date, symbol: t.symbol, direction: t.direction, grossCents: t.grossCents, feeCents: t.feeCents, notes: t.notes };
  });
  const timeZone = input.settings?.timeZone || 'Asia/Kabul';
  if (typeof timeZone !== 'string' || timeZone.length > 100) throw new Error('Invalid journal timezone.');
  try { new Intl.DateTimeFormat('en-US', { timeZone }).format(); } catch { throw new Error('Invalid journal timezone.'); }
  return { version: SCHEMA_VERSION, trades, settings: { timeZone } };
}

export function newJournal() { return { version: SCHEMA_VERSION, trades: [], settings: { timeZone: 'Asia/Kabul' } }; }

export function demoJournal(monthKey) {
  const journal = newJournal();
  const days = monthGrid(monthKey).filter((d) => d.inMonth && ![0, 6].includes(new Date(`${d.date}T12:00:00Z`).getUTCDay()));
  const results = [285, 412.5, -175, 0, 620, -95, 350, 185, -225, 480, 0, 125, 760, -150, 310, 255, -120, 540, 190, -80, 410, 225, 150];
  for (let i = 0; i < Math.min(days.length, 18); i++) {
    if (i === 3 || i === 10) continue;
    const result = results[i];
    const count = i % 3 === 0 ? 2 : 1;
    for (let n = 0; n < count; n++) {
      const net = count === 1 ? result * 100 : n === 0 ? Math.round(result * 0.6 * 100) : result * 100 - Math.round(result * 0.6 * 100);
      journal.trades.push({ id: `demo_${i}_${n}`, date: days[i].date, symbol: ['XAUUSD', 'US100', 'EURUSD', 'GBPUSD'][i % 4], direction: i % 2 ? 'short' : 'long', grossCents: net + 250, feeCents: 250, notes: 'Sample trade for exploring the calendar. This is demo data.' });
    }
  }
  return journal;
}
