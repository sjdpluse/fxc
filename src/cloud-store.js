import { validateJournal } from './domain.js';

export function parseCloudRecord(record) {
  if (!record || !Number.isSafeInteger(record.revision) || record.revision < 0) throw new Error('The cloud returned an invalid journal revision.');
  return { revision: record.revision, journal: validateJournal(record.journal) };
}

// The server checks ownership with RLS and checks the revision in one transaction.
// An uncertain write must be followed by a refresh, never a blind retry.
export class CloudJournalStore {
  constructor(client) { this.client = client; this.userId = null; this.revision = null; this.epoch = 0; this.busy = false; }
  setUser(userId) {
    if (userId === this.userId) return;
    this.userId = userId; this.revision = null; this.epoch++; this.busy = false;
  }
  async load() {
    if (!this.userId) throw new Error('Sign in to load your cloud journal.');
    if (this.busy) throw new Error('Wait for the current cloud request to finish.');
    const epoch = this.epoch;
    this.busy = true;
    try {
      const { data, error } = await this.client.rpc('fxc_load_journal');
      if (error) throw error;
      const result = parseCloudRecord(data);
      if (epoch !== this.epoch) throw new Error('Account changed. This result was discarded.');
      this.revision = result.revision;
      return result.journal;
    } catch (error) {
      if (epoch === this.epoch) this.revision = null;
      throw new Error(error.message || 'Cloud journal could not be loaded.');
    } finally { if (epoch === this.epoch) this.busy = false; }
  }
  async save(next) {
    if (!this.userId) throw new Error('Sign in to save your cloud journal.');
    if (this.revision === null) throw new Error('Refresh cloud data before saving. Your form has not been cleared.');
    if (this.busy) throw new Error('A cloud request is already in progress.');
    const journal = validateJournal(next);
    const epoch = this.epoch;
    this.busy = true;
    try {
      const { data, error } = await this.client.rpc('fxc_save_journal', { p_expected_revision: this.revision, p_journal: journal });
      if (error) throw error;
      const result = parseCloudRecord(data);
      if (epoch !== this.epoch) throw new Error('Account changed. Refresh your journal before continuing.');
      if (result.revision !== this.revision + 1) throw new Error('The cloud save could not be confirmed.');
      this.revision = result.revision;
      return result.journal;
    } catch (error) {
      if (epoch === this.epoch) this.revision = null;
      const conflict = error.code === '40001' || error.message?.includes('FXC_CONFLICT');
      throw new Error(conflict
        ? 'Another device changed this journal. Refresh cloud data, review your draft, then save again.'
        : 'Cloud save was not confirmed. Refresh cloud data before trying again. Your draft is still in the form.');
    } finally { if (epoch === this.epoch) this.busy = false; }
  }
}
