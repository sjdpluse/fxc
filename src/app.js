import { MAX_TRADES, createTradeId, dailyTotals, demoJournal, isDateKey, monthGrid, netOf, newJournal, parseMoney, shiftMonth, summarize, todayKey, validateJournal } from './domain.js';
import { STORAGE_KEY, loadJournal, mergeJournals, saveJournal } from './storage.js';
import { cloudClient, parseEmailLink } from './cloud.js';
import { CloudJournalStore } from './cloud-store.js';
import { createInstaller } from './pwa.js';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const money = (cents, signed = true, compact = false) => {
  const amount = Math.abs(cents) / 100;
  const format = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', ...(compact && amount >= 10000 ? { notation: 'compact', maximumFractionDigits: 1 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 }) });
  return `${cents < 0 ? '−' : cents > 0 && signed ? '+' : ''}${format.format(amount)}`;
};
const tone = (cents) => cents > 0 ? 'positive' : cents < 0 ? 'negative' : 'neutral';
const dayTone = (total) => !total?.count ? 'no-trade' : total.net > 0 ? 'profit' : total.net < 0 ? 'loss' : 'flat';
const displayDate = (key, options) => new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' }).format(new Date(`${key}T12:00:00Z`));
const initial = loadJournal();
let journal = initial.journal;
let writable = initial.writable;
let recoveryError = initial.error;
let snapshot;
try { snapshot = localStorage.getItem(STORAGE_KEY); } catch { snapshot = undefined; }
let demo = null;
let selectedDate = todayKey(journal.settings.timeZone);
let viewMonth = selectedDate.slice(0, 7);
let view = 'calendar';
let deleteId = null;
let importJournal = null;
let importSequence = 0;
let page = 0;
let toastTimer;
const cloudStore = new CloudJournalStore(cloudClient);
let authUser = null;
let authReady = false;
let cloudLoading = false;
let cloudError = '';
let saving = false;
let authMode = 'signin';
let authBusy = false;
let recoveryMode = false;
const PAGE_SIZE = 25;
const active = () => demo || journal;
const installer = createInstaller({ onChange: renderInstallState });

function toast(message, error = false) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').classList.toggle('error', error);
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, error ? 7000 : 3500);
}

async function commit(next, { restore = false } = {}) {
  const validated = validateJournal(next);
  if (demo) { demo = validated; render(); return; }
  if (!authReady) throw new Error('Checking your account. Please wait a moment.');
  if (saving) throw new Error('A save is already in progress.');
  if (authUser) {
    if (cloudLoading) throw new Error('Wait for your cloud journal to load.');
    saving = true; render();
    try {
      journal = await cloudStore.save(validated);
      cloudError = ''; writable = true;
    } catch (error) { cloudError = error.message; throw error; }
    finally { saving = false; render(); }
    return;
  }
  if (!writable && !restore) throw new Error('Your saved journal needs recovery. Import a valid backup using Replace journal before saving.');
  try {
    if (snapshot !== undefined && localStorage.getItem(STORAGE_KEY) !== snapshot) throw new Error('Journal changed in another tab. Reload this page before saving.');
    const saved = saveJournal(validated);
    snapshot = JSON.stringify(saved);
    journal = saved;
    writable = true;
    $('#recovery-banner').hidden = true;
  } catch (error) {
    if (['QuotaExceededError', 'SecurityError'].includes(error.name)) throw new Error('Browser storage is full or unavailable. Your change was not saved. Export a backup and check your browser storage settings.');
    throw error;
  }
  render();
}

function statCard(label, value, note, symbol, className = '') {
  return `<article class="stat-card"><div class="stat-top"><h2>${label}</h2><span class="stat-icon">${icon(symbol)}</span></div><div class="stat-number ${className}">${value}</div><div class="stat-foot">${note}</div></article>`;
}

function renderStats(trades) {
  const stats = summarize(trades);
  const factor = stats.profitFactor === null ? '—' : stats.profitFactor === Infinity ? '∞' : stats.profitFactor.toFixed(2);
  $('#stats').innerHTML = [
    statCard('Net P&L', escape(money(stats.net)), 'After fees & commissions', 'trend', tone(stats.net)),
    statCard('Win rate', `${stats.winRate.toFixed(1)}<span class="stat-percent">%</span>`, `<strong>${stats.wins}W</strong> / <strong>${stats.losses}L</strong> / ${stats.flat} break-even`, 'target'),
    statCard('Total trades', String(stats.count), `<strong>${stats.days}</strong> active ${stats.days === 1 ? 'trading day' : 'trading days'}`, 'activity'),
    statCard('Profit factor', factor, 'Net gains ÷ absolute net losses', 'chart')
  ].join('');
}

function renderSidebar(trades) {
  const totals = [...dailyTotals(trades).values()];
  const winning = totals.filter((t) => t.net > 0).length;
  const sum = summarize(trades);
  $('#sidebar-month-label').textContent = displayDate(`${viewMonth}-01`, { month: 'long' }).toUpperCase() + ' NET P&L';
  $('#sidebar-net').textContent = money(sum.net, true, true);
  $('#sidebar-net').className = `sidebar-amount ${tone(sum.net)}`;
  $('#sidebar-days').textContent = `${totals.length} active trading ${totals.length === 1 ? 'day' : 'days'}`;
  $('#sidebar-winning-days').textContent = `${winning} / ${totals.length}`;
  $('#sidebar-meter-fill').style.width = `${totals.length ? winning / totals.length * 100 : 0}%`;
}

function renderCalendar() {
  const today = todayKey(active().settings.timeZone);
  const totals = dailyTotals(active().trades);
  const grid = monthGrid(viewMonth);
  let html = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => `<div class="weekday">${d}</div>`).join('') + '<div class="week-label">Week</div>';
  for (let offset = 0; offset < grid.length; offset += 7) {
    const week = grid.slice(offset, offset + 7);
    let weekNet = 0, weekCount = 0;
    for (const day of week) {
      const total = totals.get(day.date);
      if (day.inMonth) { weekNet += total?.net || 0; weekCount += total?.count || 0; }
      const count = total?.count || 0;
      const isSelected = day.date === selectedDate;
      const label = `${displayDate(day.date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}, ${count ? `${money(total.net)} net, ${count} ${count === 1 ? 'trade' : 'trades'}` : 'no trades'}`;
      html += `<button class="day-cell ${dayTone(total)}${day.inMonth ? '' : ' outside'}${isSelected ? ' selected' : ''}${day.date === today ? ' is-today' : ''}" data-date="${day.date}" aria-label="${escape(label)}" aria-pressed="${isSelected}"${isSelected ? ' tabindex="0"' : ' tabindex="-1"'}${day.date === today ? ' aria-current="date"' : ''} title="${escape(label)}"><span class="day-top"><span class="day-number">${Number(day.date.slice(8))}</span>${count ? '<i class="day-indicator" aria-hidden="true"></i>' : ''}</span>${count ? `<span class="day-money">${escape(money(total.net, true, true))}</span><span class="day-trades">${count} ${count === 1 ? 'trade' : 'trades'}</span>` : '<span class="day-money day-empty">No trades</span><span class="day-trades" aria-hidden="true">&nbsp;</span>'}</button>`;
    }
    html += `<div class="week-total" aria-label="Week ${offset / 7 + 1}, selected month trades only, ${escape(money(weekNet))}"><span>W${offset / 7 + 1}</span><strong class="${weekCount ? tone(weekNet) : ''}" title="${escape(money(weekNet))}">${weekCount ? escape(money(weekNet, true, true)) : '—'}</strong><small>${weekCount ? `${weekCount} ${weekCount === 1 ? 'trade' : 'trades'}` : 'No trades'}</small></div>`;
  }
  $('#calendar').innerHTML = html;
  $('#month-heading').textContent = displayDate(`${viewMonth}-01`, { month: 'long' });
  $('#month-year').textContent = viewMonth.slice(0, 4);
  $('#month-picker').value = viewMonth;
  $('#previous-month').disabled = viewMonth === '1900-01';
  $('#next-month').disabled = viewMonth === '2100-12';
  const monthTrades = active().trades.filter((t) => t.date.startsWith(viewMonth));
  const days = dailyTotals(monthTrades);
  const wins = [...days.values()].filter((d) => d.net > 0).length;
  const losses = [...days.values()].filter((d) => d.net < 0).length;
  $('#calendar-footer-text').textContent = `${wins} winning ${wins === 1 ? 'day' : 'days'} · ${losses} losing ${losses === 1 ? 'day' : 'days'}`;
  $('#timezone-label').textContent = active().settings.timeZone;
}

function tradeCard(trade) {
  const net = netOf(trade);
  return `<article class="trade-card"><div class="trade-card-top"><span class="trade-card-symbol">${escape(trade.symbol)}</span><span class="direction-tag ${trade.direction}">${trade.direction}</span></div><div class="trade-card-pnl ${tone(net)}">${escape(money(net))}</div>${trade.notes ? `<p class="trade-notes">${escape(trade.notes)}</p>` : ''}<div class="trade-card-bottom"><span>Fees ${escape(money(trade.feeCents, false))}</span><div><button class="icon-button" data-edit="${trade.id}" aria-label="Edit ${escape(trade.symbol)} trade">${icon('edit')}</button><button class="icon-button" data-delete="${trade.id}" aria-label="Delete ${escape(trade.symbol)} trade">${icon('trash')}</button></div></div></article>`;
}

function renderDay() {
  const trades = active().trades.filter((t) => t.date === selectedDate);
  const stats = summarize(trades);
  const status = !stats.count ? 'No trades' : stats.net > 0 ? 'Profit day' : stats.net < 0 ? 'Loss day' : 'Break-even';
  const badge = !stats.count ? '' : stats.net > 0 ? 'profit' : stats.net < 0 ? 'loss' : 'flat';
  $('#day-detail').innerHTML = `<div class="day-overview"><div><div class="day-panel-top"><span class="eyebrow">DAILY JOURNAL</span>${selectedDate === todayKey(active().settings.timeZone) ? '<span class="result-label">Today</span>' : ''}</div><h2 id="day-heading">${escape(displayDate(selectedDate, { weekday: 'short', month: 'short', day: 'numeric' }))}</h2><p class="day-year">${selectedDate.slice(0, 4)}</p></div><div class="day-result"><div class="day-result-top"><span>Net P&L</span><span class="result-label ${badge}">${status}</span></div><div class="day-result-amount ${tone(stats.net)}">${escape(money(stats.net))}</div><div class="day-result-stats"><span>${stats.count} ${stats.count === 1 ? 'trade' : 'trades'}</span><span>${stats.wins}W · ${stats.losses}L${stats.flat ? ` · ${stats.flat}BE` : ''}</span></div></div></div><div class="detail-content">${trades.length ? `<div class="detail-list-heading">Trade breakdown <span>NET RESULT</span></div><div class="detail-trades">${trades.map(tradeCard).join('')}</div>` : `<div class="empty-day"><span class="empty-day-icon">${icon('calendar')}</span><h3>No trades recorded</h3><p>A day on the sidelines counts, too. Add a trade when you're ready.</p></div>`}<button class="button secondary daily-add" data-action="add-day">${icon('plus')}Add trade for this day</button></div><div class="daily-reminder">${icon('info')}<span>${trades.length ? 'Small, consistent improvements add up. Review your execution as well as your result.' : 'Select any day to review its trades. Use the arrow keys to move through the calendar.'}</span></div>`;
}

function renderChart(monthTrades) {
  const totals = dailyTotals(monthTrades);
  const inMonth = monthGrid(viewMonth).filter((d) => d.inMonth);
  const points = [0];
  for (const day of inMonth) points.push(points.at(-1) + (totals.get(day.date)?.net || 0));
  const net = points.at(-1);
  $('#performance-net').textContent = money(net);
  $('#performance-net').className = tone(net);
  let low = Math.min(0, ...points), high = Math.max(0, ...points);
  if (low === high) { low = -10000; high = 10000; }
  const span = high - low || 10000;
  const min = low - span * .12, max = high + span * .12;
  const width = Math.max(300, $('#performance-chart').clientWidth), left = 53, right = width - 8, bottom = 128;
  const x = (index) => left + index / (points.length - 1) * (right - left);
  const y = (value) => bottom - (value - min) / (max - min) * (bottom - top);
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(2)},${y(p).toFixed(2)}`).join(' ');
  const area = `${path} L${right},${y(0).toFixed(2)} L${left},${y(0).toFixed(2)} Z`;
  const chartClass = net < 0 ? ' loss' : '';
  let lines = '';
  for (const value of [high, (high + low) / 2, low]) {
    lines += `<line x1="${left}" y1="${y(value)}" x2="${right}" y2="${y(value)}" class="chart-grid"/><text x="0" y="${y(value) + 3}" class="chart-label">${escape(money(value, false, true))}</text>`;
  }
  let labels = '';
  for (const day of [1, 7, 14, 21, inMonth.length]) labels += `<text x="${x(day)}" y="153" text-anchor="${day === inMonth.length ? 'end' : 'middle'}" class="chart-label">${escape(displayDate(`${viewMonth}-${String(day).padStart(2, '0')}`, { month: 'short', day: 'numeric' }))}</text>`;
  const description = monthTrades.length ? `${displayDate(`${viewMonth}-01`, { month: 'long', year: 'numeric' })}: ${money(net)} cumulative net profit and loss across ${monthTrades.length} ${monthTrades.length === 1 ? 'trade' : 'trades'}.` : 'No trades in the selected month. The cumulative net profit and loss is zero.';
  $('#performance-chart').innerHTML = `<div class="chart-wrap"><svg class="performance-svg" viewBox="0 0 ${width} 165" preserveAspectRatio="none" role="img" aria-label="${escape(description)}"><title>${escape(description)}</title>${lines}<line class="chart-zero" x1="${left}" y1="${y(0)}" x2="${right}" y2="${y(0)}"/>${monthTrades.length ? `<path d="${area}" class="chart-area${chartClass}"/><path d="${path}" class="chart-line${chartClass}"/><circle cx="${right}" cy="${y(net)}" r="4.5" class="chart-point${chartClass}"/>` : ''}${labels}</svg>${monthTrades.length ? '' : `<div class="chart-empty"><h3>Your progress starts with one trade.</h3><p>Log your results to see your performance take shape.</p><button class="text-button" data-action="add">Add your first trade ${icon('arrow')}</button></div>`}</div><div class="chart-caption">${monthTrades.length ? 'Starts at $0 each month · Weekly totals include this month only' : 'No sample data is added to your journal automatically'}</div>`;
}

function filteredTrades() {
  const query = $('#trade-search').value.trim().toLowerCase();
  return active().trades.filter((t) => `${t.symbol} ${t.notes} ${t.date} ${t.direction}`.toLowerCase().includes(query)).sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
}

function renderTradeTable() {
  const trades = filteredTrades();
  const totalPages = Math.max(1, Math.ceil(trades.length / PAGE_SIZE));
  page = Math.min(page, totalPages - 1);
  $('#trade-log-count').textContent = `${trades.length} ${trades.length === 1 ? 'trade' : 'trades'}${$('#trade-search').value ? ' found' : ' across your journal'}`;
  if (!trades.length) {
    $('#trade-table').innerHTML = `<div class="table-empty"><span class="empty-day-icon">${icon('list')}</span><h3>${active().trades.length ? 'No matching trades' : 'A fresh start for your journal'}</h3><p>${active().trades.length ? 'Try another instrument, date, or keyword.' : 'Record your first trade and build a clearer view of your performance.'}</p>${active().trades.length ? '' : `<button class="button primary" data-action="add">${icon('plus')}Add your first trade</button>`}</div>`;
    return;
  }
  const rows = trades.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((t) => `<tr><td>${escape(displayDate(t.date, { month: 'short', day: 'numeric', year: 'numeric' }))}</td><td class="table-symbol">${escape(t.symbol)}</td><td><span class="direction-tag ${t.direction}">${t.direction}</span></td><td class="table-money ${tone(netOf(t))}">${escape(money(netOf(t)))}</td><td class="muted">${escape(money(t.feeCents, false))}</td><td class="table-note">${escape(t.notes || '—')}</td><td><div class="table-actions"><button class="icon-button" data-edit="${t.id}" aria-label="Edit ${escape(t.symbol)} trade on ${t.date}">${icon('edit')}</button><button class="icon-button" data-delete="${t.id}" aria-label="Delete ${escape(t.symbol)} trade on ${t.date}">${icon('trash')}</button></div></td></tr>`).join('');
  $('#trade-table').innerHTML = `<div class="table-scroll"><table class="trade-table"><thead><tr><th scope="col">DATE</th><th scope="col">INSTRUMENT</th><th scope="col">DIRECTION</th><th scope="col">NET P&L</th><th scope="col">FEES</th><th scope="col">NOTES</th><th scope="col">ACTIONS</th></tr></thead><tbody>${rows}</tbody></table></div><div class="table-pagination"><span>${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, trades.length)} of ${trades.length} trades</span><div><button class="icon-button" data-page="-1" aria-label="Previous page" ${page === 0 ? 'disabled' : ''}>${icon('left')}</button><span>${page + 1} / ${totalPages}</span><button class="icon-button" data-page="1" aria-label="Next page" ${page === totalPages - 1 ? 'disabled' : ''}>${icon('right')}</button></div></div>`;
}

function render() {
  const monthTrades = active().trades.filter((t) => t.date.startsWith(viewMonth));
  renderStats(monthTrades);
  renderSidebar(monthTrades);
  renderCalendar();
  renderDay();
  renderChart(monthTrades);
  renderTradeTable();
  $('#calendar-view').hidden = view !== 'calendar';
  $('#trades-view').hidden = view !== 'trades';
  $('#page-title').textContent = view === 'calendar' ? 'Trading calendar' : 'Trade log';
  $('#page-breadcrumb').textContent = view === 'calendar' ? 'Trading calendar' : 'Trade log';
  $('#page-subtitle').textContent = view === 'calendar' ? 'Every trade tells a story. See the bigger picture.' : `Every entry, every lesson. Statistics above reflect ${displayDate(`${viewMonth}-01`, { month: 'long', year: 'numeric' })}.`;
  $$('.nav-item').forEach((button) => {
    const selected = button.dataset.view === view;
    button.classList.toggle('active', selected);
    if (selected) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  });
  $('#demo-banner').hidden = !demo;
  $('#demo-button').hidden = !!demo;
  $('#export-backup').disabled = !!demo || !writable;
  $('#import-backup').disabled = !!demo;
  $('#export-csv').disabled = !!demo || !active().trades.length;
  renderCloudState();
}

function renderCloudState() {
  const busy = saving || cloudLoading || !authReady;
  const ready = demo || (authReady && !busy && (!authUser || cloudStore.revision !== null));
  $('#save-status').innerHTML = `<i></i>${demo ? 'Demo journal' : saving ? 'Saving to cloud…' : !authReady ? 'Checking account…' : cloudLoading ? 'Loading cloud…' : authUser ? cloudError ? 'Cloud unavailable' : 'Cloud journal' : !writable ? 'Recovery needed' : 'Local journal'}`;
  $('#save-status').classList.toggle('busy', busy);
  $('#storage-location').textContent = demo ? 'Temporary sample data' : authUser ? 'Stored in Supabase' : 'Stored in this browser';
  $('#account-button').innerHTML = authUser ? icon('user') : 'Sign in';
  $('#account-button').classList.toggle('is-profile', !!authUser);
  $('#account-button').setAttribute('aria-label', authUser ? 'Open profile' : 'Sign in');
  $('#account-button').title = authUser ? 'Your profile' : 'Sign in to your cloud journal';
  $('#account-button').disabled = !authReady || saving || cloudLoading;
  $('#profile-cloud-status').textContent = cloudError || (saving ? 'Saving changes…' : cloudLoading ? 'Loading your cloud journal…' : 'Your journal is up to date. Use Refresh to load changes from another device.');
  $('#profile-cloud-status').classList.toggle('error', !!cloudError);
  $('#save-status').title = cloudError || (authUser ? 'Changes are saved to your account. Open your profile to refresh.' : 'Sign in next to Settings to use cloud storage.');
  $('#save-status').classList.toggle('error', !!cloudError);
  $('#recovery-banner').hidden = !!authUser || !recoveryError || writable;
  for (const button of $$('#save-trade, #confirm-delete, #settings-form button[type="submit"]')) button.disabled = !ready;
  $('#import-submit').disabled = !ready || !importJournal;
  $('#sign-out').disabled = saving || cloudLoading || authBusy;
  $('#refresh-account').disabled = busy;
  $('#migrate-local').disabled = busy || !!demo || cloudStore.revision === null;
  $('#import-backup').disabled = !!demo || busy;
  $('#export-backup').disabled = !!demo || !writable || busy || (!!authUser && cloudStore.revision === null);
  $('#export-csv').disabled = !!demo || !journal.trades.length || busy;
  for (const field of $$('#trade-form input, #trade-form select, #trade-form textarea, #settings-form select, #import-file')) field.disabled = saving;
  $('#privacy-description').textContent = authUser ? 'Cloud trades are stored in your account and protected by database access policies. Local trades stay separate. Keep an exported backup as an additional copy.' : 'Local trades are stored in this browser. Sign in for cloud storage and use Export backup to keep your own copy. There is no broker connection.';
}

function selectDate(date, { focus = false } = {}) {
  if (!isDateKey(date)) return;
  selectedDate = date;
  viewMonth = date.slice(0, 7);
  render();
  if (focus) $(`[data-date="${date}"]`)?.focus({ preventScroll: true });
}

function changeMonth(next) {
  if (!isDateKey(`${next}-01`)) return;
  viewMonth = next;
  // Keep the same day when possible; clamp to the last day of a shorter month.
  const lastDay = monthGrid(next).filter((d) => d.inMonth).at(-1).date;
  const desired = `${next}-${selectedDate.slice(8)}`;
  selectedDate = isDateKey(desired) ? desired : lastDay;
  render();
}

function formError(id, error) {
  const element = $(id);
  element.textContent = error?.message || String(error);
  element.hidden = false;
}

function showTrade(id = null, date = selectedDate) {
  const trade = id ? active().trades.find((t) => t.id === id) : null;
  if (id && !trade) { toast('This trade no longer exists.', true); return; }
  $('#trade-form').reset();
  $('#trade-form-error').hidden = true;
  $('#trade-dialog-title').textContent = trade ? 'Edit trade' : 'Add a trade';
  $('#save-trade').textContent = trade ? 'Save changes' : 'Save trade';
  $('#trade-id').value = trade?.id || '';
  $('#trade-date').value = trade?.date || date;
  $('#trade-symbol').value = trade?.symbol || '';
  $('#trade-direction').value = trade?.direction || 'long';
  $('#trade-gross').value = trade ? (trade.grossCents / 100).toFixed(2) : '';
  $('#trade-fees').value = trade ? (trade.feeCents / 100).toFixed(2) : '0';
  $('#trade-notes').value = trade?.notes || '';
  updateNetPreview();
  $('#trade-dialog').showModal();
}

function updateNetPreview() {
  try {
    const net = parseMoney($('#trade-gross').value || '0') - parseMoney($('#trade-fees').value || '0', { nonnegative: true });
    $('#trade-net-preview').textContent = money(net);
    $('#trade-net-preview').className = tone(net);
  } catch { $('#trade-net-preview').textContent = '—'; $('#trade-net-preview').className = 'neutral'; }
}

function download(content, filename, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function enterDemo() {
  demo = demoJournal(viewMonth);
  selectedDate = demo.trades.at(-1)?.date || `${viewMonth}-01`;
  view = 'calendar'; page = 0;
  render();
  toast('Exploring sample data. Your journal stays separate.');
}

document.addEventListener('click', (event) => {
  const target = event.target.closest('button');
  if (!target || target.disabled) return;
  if (target.dataset.view) { view = target.dataset.view; render(); }
  if (target.dataset.date) selectDate(target.dataset.date, { focus: true });
  if (target.dataset.action === 'add') showTrade(null, todayKey(active().settings.timeZone));
  if (target.dataset.action === 'add-day') showTrade();
  if (target.dataset.edit) showTrade(target.dataset.edit);
  if (target.dataset.delete) { deleteId = target.dataset.delete; $('#delete-error').hidden = true; $('#confirm-dialog').showModal(); }
  if (target.dataset.close) $(`#${target.dataset.close}`).close();
  if (target.dataset.page) { page += Number(target.dataset.page); renderTradeTable(); }
});

$('#calendar').addEventListener('keydown', (event) => {
  const current = event.target.closest('[data-date]');
  if (!current) return;
  const steps = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
  let step = steps[event.key];
  if (event.key === 'Home') step = -((new Date(`${current.dataset.date}T12:00:00Z`).getUTCDay() + 6) % 7);
  if (event.key === 'End') step = 6 - ((new Date(`${current.dataset.date}T12:00:00Z`).getUTCDay() + 6) % 7);
  if (step === undefined) return;
  event.preventDefault();
  const date = new Date(`${current.dataset.date}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + step);
  selectDate(date.toISOString().slice(0, 10), { focus: true });
});
$('#previous-month').addEventListener('click', () => changeMonth(shiftMonth(viewMonth, -1)));
$('#next-month').addEventListener('click', () => changeMonth(shiftMonth(viewMonth, 1)));
$('#month-picker').addEventListener('change', (event) => changeMonth(event.target.value));
$('#today-button').addEventListener('click', () => selectDate(todayKey(active().settings.timeZone)));
$('#trade-search').addEventListener('input', () => { page = 0; renderTradeTable(); });
$('#trade-gross').addEventListener('input', updateNetPreview);
$('#trade-fees').addEventListener('input', updateNetPreview);
$('#trade-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#trade-form-error').hidden = true;
  try {
    const id = $('#trade-id').value;
    if (!id && active().trades.length >= MAX_TRADES) throw new Error(`This journal supports up to ${MAX_TRADES.toLocaleString('en-US')} trades.`);
    if (id && !active().trades.some((t) => t.id === id)) throw new Error('This trade was removed in another tab. Close this form and add a new trade.');
    const trade = {
      id: id || createTradeId(), date: $('#trade-date').value,
      symbol: $('#trade-symbol').value.trim().toUpperCase().replace(/\s+/g, ' '),
      direction: $('#trade-direction').value,
      grossCents: parseMoney($('#trade-gross').value), feeCents: parseMoney($('#trade-fees').value, { nonnegative: true }),
      notes: $('#trade-notes').value.trim()
    };
    if (!isDateKey(trade.date)) throw new Error('Choose a valid trade date between 1900 and 2100.');
    if (!/^[A-Z0-9][A-Z0-9 ./_-]{0,19}$/.test(trade.symbol)) throw new Error('Instrument must contain 1–20 letters, numbers, spaces, dots, slashes, underscores, or hyphens.');
    const trades = id ? active().trades.map((t) => t.id === id ? trade : t) : [...active().trades, trade];
    await commit({ ...active(), trades });
    selectDate(trade.date);
    $('#trade-dialog').close();
    toast(demo ? 'Demo trade updated. Changes are not saved.' : id ? 'Trade updated. Calendar recalculated.' : 'Trade saved to your journal.');
  } catch (error) { formError('#trade-form-error', error); }
});

$('#confirm-delete').addEventListener('click', async () => {
  try {
    await commit({ ...active(), trades: active().trades.filter((t) => t.id !== deleteId) });
    $('#confirm-dialog').close(); deleteId = null;
    toast(demo ? 'Demo trade deleted. Changes are not saved.' : 'Trade deleted. Calendar recalculated.');
  } catch (error) { formError('#delete-error', error); }
});

$('#export-backup').addEventListener('click', () => {
  download(JSON.stringify(journal, null, 2) + '\n', `fxc-backup-${todayKey(journal.settings.timeZone)}.json`, 'application/json');
  toast('Backup exported. Keep it somewhere safe.');
});
$('#download-recovery').addEventListener('click', () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) throw new Error('No saved data is accessible in this browser.');
    download(raw, `fxc-recovery-${todayKey()}.txt`, 'text/plain');
    toast('Recovery file downloaded. The original data has not been changed.');
  } catch (error) { toast(error.message, true); }
});
$('#import-backup').addEventListener('click', () => {
  importSequence++; importJournal = null;
  $('#import-form').reset(); $('#import-error').hidden = true; $('#import-submit').disabled = true;
  $('#import-summary').textContent = 'No file selected.';
  if (!writable) $('#import-form [value="replace"]').checked = true;
  $('#import-dialog').showModal();
});
$('#import-file').addEventListener('change', async (event) => {
  const sequence = ++importSequence;
  importJournal = null; $('#import-submit').disabled = true; $('#import-error').hidden = true;
  const file = event.target.files[0];
  if (!file) { $('#import-summary').textContent = 'No file selected.'; return; }
  $('#import-summary').textContent = 'Checking backup…';
  try {
    if (file.size > 32 * 1024 * 1024) throw new Error('Backup is too large. Maximum file size is 32 MB.');
    const parsed = validateJournal(JSON.parse(await file.text()));
    if (sequence !== importSequence) return;
    importJournal = parsed;
    $('#import-summary').textContent = `${parsed.trades.length} valid ${parsed.trades.length === 1 ? 'trade' : 'trades'} found · ${money(summarize(parsed.trades).net)} net P&L.`;
    $('#import-submit').disabled = false;
  } catch (error) {
    if (sequence !== importSequence) return;
    $('#import-summary').textContent = 'Backup could not be loaded.';
    formError('#import-error', error instanceof SyntaxError ? new Error('The file is not valid JSON. Choose an FXC JSON backup.') : error);
  }
});
$('#import-form').addEventListener('submit', async (event) => {
  event.preventDefault(); $('#import-error').hidden = true;
  try {
    if (!importJournal) throw new Error('Choose a valid backup first.');
    const replace = $('#import-form [name="import-mode"]:checked').value === 'replace';
    if (!writable && !replace) throw new Error('Use Replace journal to restore unreadable saved data. Download the recovery file first.');
    const result = replace ? { journal: importJournal, added: importJournal.trades.length } : mergeJournals(journal, importJournal);
    await commit(result.journal, { restore: replace });
    if (result.journal.trades.length) selectDate([...result.journal.trades].sort((a, b) => b.date.localeCompare(a.date))[0].date);
    $('#import-dialog').close();
    toast(replace ? `Journal restored: ${result.added} ${result.added === 1 ? 'trade' : 'trades'}.` : `${result.added} ${result.added === 1 ? 'trade' : 'trades'} imported. ${result.unchanged} ${result.unchanged === 1 ? 'duplicate' : 'duplicates'} skipped.`);
  } catch (error) { formError('#import-error', error); }
});

$('#export-csv').addEventListener('click', () => {
  const cell = (value) => {
    let text = String(value);
    if (/^[=+\-@\t\r\n]/.test(text)) text = "'" + text;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const rows = [['Date', 'Instrument', 'Direction', 'Gross P&L (USD)', 'Fees (USD)', 'Net P&L (USD)', 'Notes'], ...[...journal.trades].sort((a, b) => a.date.localeCompare(b.date)).map((t) => [t.date, t.symbol, t.direction, (t.grossCents / 100).toFixed(2), (t.feeCents / 100).toFixed(2), (netOf(t) / 100).toFixed(2), t.notes])];
  // Only free-text cells need formula protection; signed numeric amounts stay numeric.
  const csv = rows.map((row, index) => row.map((value, col) => index && [3, 4, 5].includes(col) ? String(value) : cell(value)).join(',')).join('\r\n');
  download('\uFEFF' + csv + '\r\n', `fxc-trades-${todayKey(journal.settings.timeZone)}.csv`, 'text/csv;charset=utf-8');
  toast('Trade history exported as CSV.');
});
$('#settings-button').addEventListener('click', () => {
  const zone = active().settings.timeZone;
  $('#timezone-select [data-custom]')?.remove();
  if (!$$('#timezone-select option').some((o) => o.value === zone)) {
    const option = document.createElement('option'); option.value = zone; option.textContent = zone; option.dataset.custom = 'true'; $('#timezone-select').append(option);
  }
  $('#timezone-select').value = zone; $('#settings-error').hidden = true;
  renderInstallState();
  $('#settings-dialog').showModal();
});
$('#settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await commit({ ...active(), settings: { timeZone: $('#timezone-select').value } });
    $('#settings-dialog').close(); toast(demo ? 'Demo preference updated. Changes are not saved.' : 'Preferences saved.');
  } catch (error) { formError('#settings-error', error); }
});
$('#demo-button').addEventListener('click', enterDemo);
$('#exit-demo').addEventListener('click', () => {
  demo = null; selectedDate = todayKey(journal.settings.timeZone); viewMonth = selectedDate.slice(0, 7); page = 0; $('#trade-search').value = '';
  render(); toast('Back to your personal journal.');
});

window.addEventListener('storage', (event) => {
  if (event.key !== STORAGE_KEY && event.key !== null) return;
  if (authUser) return; // Local journal updates must never replace a signed-in account.
  const result = loadJournal();
  journal = result.journal; writable = result.writable; recoveryError = result.error;
  try { snapshot = localStorage.getItem(STORAGE_KEY); } catch { snapshot = undefined; }
  $('#recovery-banner').hidden = !result.error;
  $('#recovery-message').textContent = result.error || '';
  render();
  toast(result.error || 'Journal updated from another tab.', !!result.error);
});
let resizeFrame;
window.addEventListener('resize', () => {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => renderChart(active().trades.filter((t) => t.date.startsWith(viewMonth))));
});
if (initial.error) { $('#recovery-banner').hidden = false; $('#recovery-message').textContent = initial.error; }
render();

async function refreshCloud() {
  if (!authUser || saving || cloudLoading) return;
  const userId = authUser.id;
  cloudLoading = true; cloudError = ''; render();
  try {
    const loaded = await cloudStore.load();
    if (authUser?.id !== userId) return;
    journal = loaded; writable = true;
  } catch (error) {
    if (authUser?.id === userId) cloudError = error.message;
  } finally {
    if (authUser?.id === userId) { cloudLoading = false; render(); updateAccountPanel(); }
  }
}

async function applySession(session, event = '') {
  const user = session?.user || null;
  if (event === 'PASSWORD_RECOVERY') recoveryMode = true;
  if (authReady && user?.id === authUser?.id) {
    authUser = user; renderCloudState();
    if (recoveryMode) openAccount();
    return;
  }
  authReady = true; authUser = user; cloudLoading = false; cloudError = '';
  cloudStore.setUser(user?.id || null);
  demo = null; page = 0;
  for (const id of ['trade-dialog', 'confirm-dialog', 'import-dialog', 'settings-dialog']) $(`#${id}`).close();
  $('#trade-form').reset(); $('#import-form').reset(); importJournal = null; importSequence++;
  if (user) { journal = newJournal(); writable = true; }
  else {
    const loaded = loadJournal(); journal = loaded.journal; writable = loaded.writable; recoveryError = loaded.error;
    $('#recovery-message').textContent = recoveryError || '';
    try { snapshot = localStorage.getItem(STORAGE_KEY); } catch { snapshot = undefined; }
    recoveryMode = false;
  }
  selectedDate = todayKey(journal.settings.timeZone); viewMonth = selectedDate.slice(0, 7);
  render(); updateAccountPanel();
  if (user) await refreshCloud();
  if (recoveryMode) openAccount();
}

function setAuthMode(mode) {
  authMode = mode;
  $('#auth-password-label').hidden = mode === 'reset';
  $('#auth-password').required = mode !== 'reset';
  $('#auth-password').autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
  $('#sign-in-tab').classList.toggle('active', mode === 'signin');
  $('#sign-up-tab').classList.toggle('active', mode === 'signup');
  $('#auth-submit').textContent = mode === 'signup' ? 'Create account' : mode === 'reset' ? 'Send recovery email' : 'Sign in';
  $('#forgot-password').hidden = mode === 'reset';
  $('#account-error').hidden = true; $('#account-message').hidden = true;
  $('#account-title').textContent = mode === 'reset' ? 'Reset your password' : mode === 'signup' ? 'Create your FXC account' : 'Sign in to FXC';
}

function updateAccountPanel() {
  $('#signed-in-panel').hidden = !authUser || recoveryMode;
  $('#signed-out-panel').hidden = !!authUser || recoveryMode;
  $('#new-password-form').hidden = !recoveryMode;
  if (authUser) {
    $('#account-title').textContent = recoveryMode ? 'Choose a new password' : 'Your cloud account';
    $('#account-email').textContent = authUser.email;
    const local = loadJournal();
    $('#local-migration').hidden = !!demo || !local.writable || !local.journal.trades.length;
    $('#local-migration-description').textContent = `${local.journal.trades.length} ${local.journal.trades.length === 1 ? 'trade is' : 'trades are'} saved locally on this device. Import them into this account when you're ready.`;
  } else setAuthMode(authMode);
  renderCloudState();
}

function openAccount() {
  $('#account-error').hidden = true; $('#account-message').hidden = true;
  updateAccountPanel();
  if (!$('#account-dialog').open) $('#account-dialog').showModal();
}

function accountMessage(text) { $('#account-message').textContent = text; $('#account-message').hidden = false; }

async function authAction(action) {
  if (authBusy || saving || cloudLoading) return;
  authBusy = true; $('#account-error').hidden = true; $('#account-message').hidden = true;
  for (const button of $$('#account-dialog button:not([data-close])')) button.disabled = true;
  try { await action(); }
  catch (error) { formError('#account-error', error); }
  finally {
    authBusy = false;
    for (const button of $$('#account-dialog button:not([data-close])')) button.disabled = false;
    renderCloudState();
  }
}

$('#account-button').addEventListener('click', openAccount);
$('#refresh-account').addEventListener('click', refreshCloud);
$('#sign-in-tab').addEventListener('click', () => setAuthMode('signin'));
$('#sign-up-tab').addEventListener('click', () => setAuthMode('signup'));
$('#forgot-password').addEventListener('click', () => setAuthMode('reset'));
$('#auth-form').addEventListener('submit', (event) => {
  event.preventDefault();
  authAction(async () => {
    const email = $('#auth-email').value.trim();
    const password = $('#auth-password').value;
    if (authMode === 'reset') {
      const { error } = await cloudClient.auth.resetPasswordForEmail(email);
      if (error) throw error;
      accountMessage('If this account exists, check its email for a recovery link. You can paste the original link in the section below to finish here.');
    } else if (authMode === 'signup') {
      const { data, error } = await cloudClient.auth.signUp({ email, password });
      if (error) throw error;
      $('#auth-password').value = '';
      if (data.session) {
        await applySession(data.session); $('#account-dialog').close();
        toast('Account created. You are signed in.');
      } else {
        setAuthMode('signin');
        accountMessage('Your account was created. Sign in to continue. If email confirmation has been enabled again for this project, check your inbox first.');
      }
    } else {
      const { data, error } = await cloudClient.auth.signInWithPassword({ email, password });
      if (error) throw error;
      $('#auth-password').value = '';
      await applySession(data.session); $('#account-dialog').close();
      toast(cloudError ? 'Signed in. Refresh your cloud connection to load trades.' : cloudLoading ? 'Signed in. Loading your cloud journal…' : 'Signed in. Your cloud journal is ready.');
    }
  });
});
$('#email-link-form').addEventListener('submit', (event) => {
  event.preventDefault();
  authAction(async () => {
    const input = parseEmailLink($('#email-verification-link').value);
    $('#email-verification-link').value = '';
    const { data, error } = await cloudClient.auth.verifyOtp(input);
    if (error) throw error;
    if (input.type === 'recovery') recoveryMode = true;
    await applySession(data.session, input.type === 'recovery' ? 'PASSWORD_RECOVERY' : 'SIGNED_IN');
    updateAccountPanel();
    accountMessage(recoveryMode ? 'Recovery link verified. Choose your new password.' : 'Email verified. Your account is signed in.');
  });
});
$('#new-password-form').addEventListener('submit', (event) => {
  event.preventDefault();
  authAction(async () => {
    const { error } = await cloudClient.auth.updateUser({ password: $('#new-password').value });
    if (error) throw error;
    $('#new-password').value = ''; recoveryMode = false; updateAccountPanel();
    accountMessage('Your password has been updated.');
  });
});
$('#sign-out').addEventListener('click', () => authAction(async () => {
  const { error } = await cloudClient.auth.signOut({ scope: 'local' });
  if (error) throw error;
  await applySession(null); $('#account-dialog').close();
  toast('Signed out. You are viewing this device’s local journal.');
}));
$('#migrate-local').addEventListener('click', () => authAction(async () => {
  if (!authUser || demo) throw new Error('Open your personal cloud journal first.');
  const local = loadJournal();
  if (!local.writable) throw new Error('The local journal could not be read. Restore a valid backup first.');
  const merged = mergeJournals(journal, local.journal);
  await commit(merged.journal);
  accountMessage(`${merged.added} trades imported into your account. ${merged.unchanged} identical records skipped. The local backup remains on this device.`);
}));

// Defer work out of the auth callback to avoid blocking the SDK's session lock.
cloudClient.auth.onAuthStateChange((event, session) => { setTimeout(() => { applySession(session, event).catch((error) => toast(error.message, true)); }, 0); });
cloudClient.auth.getSession().then(({ data, error }) => {
  if (error) toast('Your account session could not be restored. Sign in again to use cloud storage.', true);
  return applySession(data?.session || null);
}).catch((error) => { authReady = true; render(); toast(error.message, true); });

function renderInstallState(state = installer.state()) {
  $('#install-app').disabled = state.installed || state.installing;
  $('#install-app').textContent = state.installed ? 'Installed' : state.installing ? 'Installing…' : 'Install app';
  $('#install-status').textContent = state.message || (state.installed ? 'You are using FXC as an installed app.' : 'Cloud sync needs an internet connection. Local journaling is available offline after the app has loaded once.');
}
$('#install-app').addEventListener('click', () => installer.install());
if (document.readyState === 'complete') installer.register();
else window.addEventListener('load', () => installer.register(), { once: true });
