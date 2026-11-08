import { newJournal, validateJournal } from './domain.js';

export const STORAGE_KEY = 'fxc.journal.v1';

export function loadJournal(storage = localStorage) {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    return { journal: raw ? validateJournal(JSON.parse(raw)) : newJournal(), error: null, writable: true };
  } catch {
    return { journal: newJournal(), error: 'Your saved journal could not be read. Download the recovery file before replacing it, or restore a valid backup.', writable: false };
  }
}

export function saveJournal(journal, storage = localStorage) {
  const clean = validateJournal(journal);
  storage.setItem(STORAGE_KEY, JSON.stringify(clean));
  return clean;
}

export function mergeJournals(current, incoming) {
  const existing = validateJournal(current);
  const next = validateJournal(incoming);
  const trades = new Map(existing.trades.map((t) => [t.id, t]));
  let added = 0, unchanged = 0;
  for (const trade of next.trades) {
    if (trades.has(trade.id)) {
      if (JSON.stringify(trades.get(trade.id)) !== JSON.stringify(trade)) throw new Error('A trade ID conflicts with an existing entry. Use Replace journal to restore this backup.');
      unchanged++;
    } else { trades.set(trade.id, trade); added++; }
  }
  return { journal: validateJournal({ ...existing, trades: [...trades.values()] }), added, unchanged };
}
