import { createHash } from 'node:crypto';

const copy = value => structuredClone(value);
export const hashHistoryValue = async value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const historyActor = 'fixture_key_a';
export const historyRow = (eventId, at = 1_800_000_000_000) => ({ eventId, at,
  kind: 'action', action: 'likePosts', target: 'Synthetic post', outcome: 'completed', detail: 'Synthetic outcome' });
export const legacyHistory = { version: 1, entries: Array.from({ length: 95 }, (_, index) =>
  historyRow('retained_' + index, 1_700_000_000_000 + index)) };
export const tickHistory = () => new Promise(resolve => setImmediate(resolve));

/** Separate manager caches; remote notification/discovery is explicitly delayed. */
export class HistoryManager {
  constructor() {
    this.values = new Map(); this.clients = new Set(); this.calls = [];
    this.beforeSet = null; this.afterSet = null; this.beforeDelete = null; this.afterDelete = null;
  }
  seed(actor = historyActor, value = legacyHistory) {
    this.values.set('instaToolboxPresenceActivityLogV1:' + actor, copy(value));
  }
  open(name) {
    const manager = this;
    const cache = new Map([...manager.values].map(([key, value]) => [key, copy(value)]));
    const listeners = new Map(); let sequence = 0, closed = false, ids = 0;
    const storage = {
      async getValue(key, fallback = null) { if (closed) throw new Error('fixture-closed'); return copy(cache.has(key) ? cache.get(key) : fallback); },
      async listValues() { if (closed) throw new Error('fixture-closed'); return [...cache.keys()]; },
      async setValue(key, value) {
        if (closed) throw new Error('fixture-closed');
        manager.calls.push({ name, kind: 'set', key, value: copy(value) });
        if (manager.beforeSet) await manager.beforeSet(key, value, name);
        manager.values.set(key, copy(value)); cache.set(key, copy(value));
        if (manager.afterSet) await manager.afterSet(key, value, name);
      },
      async deleteValue(key) {
        if (closed) throw new Error('fixture-closed');
        manager.calls.push({ name, kind: 'delete', key });
        if (manager.beforeDelete) await manager.beforeDelete(key, name);
        manager.values.delete(key); cache.delete(key);
        if (manager.afterDelete) await manager.afterDelete(key, name);
      },
      listen(key, callback) { const id = ++sequence; listeners.set(id, { key, callback }); return id; },
      unlisten(id) { listeners.delete(id); },
    };
    const client = { name, storage, cache,
      randomId: () => name + '_' + (++ids),
      readLegacy: actor => storage.getValue('instaToolboxPresenceActivityLogV1:' + actor, null),
      deliverRemote({ notify = false } = {}) {
        if (closed) throw new Error('fixture-closed');
        cache.clear(); for (const [key, value] of manager.values) cache.set(key, copy(value));
        if (notify) for (const { key, callback } of listeners.values()) callback(copy(cache.get(key)));
      },
      close() { closed = true; manager.clients.delete(client); },
    };
    manager.clients.add(client); return client;
  }
}
