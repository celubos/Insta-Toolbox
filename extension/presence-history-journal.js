import { normalizePresenceActivityLog } from './presence-activity-log.js';

const prefix = actor => 'instaToolboxPresenceActivityLogV1:' + actor + ':journal:v1:op:';
const legacyKey = actor => 'instaToolboxPresenceActivityLogV1:' + actor;
const noticeKey = actor => legacyKey(actor) + ':journal:v1:notice';
const failure = reason => new Error(reason);
const secureId = () => {
  if (typeof globalThis.crypto?.getRandomValues !== 'function') throw failure('history-randomness-unavailable');
  return [...globalThis.crypto.getRandomValues(new Uint8Array(16))]
    .map(value => value.toString(16).padStart(2, '0')).join('');
};
const contentHash = async value => {
  if (typeof globalThis.crypto?.subtle?.digest !== 'function') throw failure('history-hash-unavailable');
  const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
};

const clone = value => structuredClone(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function validOperation(key, value, actor) {
  if (!value || value.version !== 1 || value.actor !== actor
    || !['baseline', 'append', 'clear', 'checkpoint'].includes(value.kind)
    || typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value.id)
    || key !== prefix(actor) + value.id || !Array.isArray(value.clearIds)
    || value.clearIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id))
    || new Set(value.clearIds).size !== value.clearIds.length
    || !Array.isArray(value.entries) || value.entries.length > 500) return null;
  const normalized = normalizePresenceActivityLog({ entries: value.entries });
  if (!same(normalized.entries, value.entries)) return null;
  if (value.kind === 'clear' && value.entries.length) return null;
  if (value.kind === 'baseline' && (value.clearIds.length || !/^baseline_[a-f0-9]{64}$/.test(value.id))) return null;
  if (value.kind === 'checkpoint' && (!Array.isArray(value.covers) || value.covers.length > 32
    || value.covers.some(ref => !ref || !ref.key?.startsWith(prefix(actor)) || !/^[a-f0-9]{64}$/.test(ref.hash))
    || !Array.isArray(value.rows) || value.rows.length > 500 || value.entries.length
    || value.rows.some(row => !row || !same(normalizePresenceActivityLog({ entries: [row.entry] }).entries, [row.entry])
      || !Array.isArray(row.contexts) || !row.contexts.length || row.contexts.some(context => !Array.isArray(context)
        || context.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id))))
    || !Array.isArray(value.legacyImportIds)
    || value.legacyImportIds.some(id => typeof id !== 'string' || !/^baseline_[a-f0-9]{64}$/.test(id)))) return null;
  return clone(value);
}

function reduceView(known, actor, unresolvedKeys = []) {
  const operations = [...known].flatMap(([key, value]) => {
    const operation = validOperation(key, value, actor);
    return operation ? [operation] : [];
  });
  // Every observed immutable Clear barrier remains in the applied fence set.
  // Time never chooses a winning Clear or establishes discovery completeness.
  const clearIds = [...new Set(operations.flatMap(op => [
    ...(op.kind === 'clear' ? [op.id] : []),
    ...(op.kind === 'checkpoint' ? op.clearIds : []),
  ]))].sort();
  const legacyImportIds = [...new Set(operations.flatMap(op => op.kind === 'baseline'
    ? [op.id] : op.kind === 'checkpoint' ? op.legacyImportIds : []))].sort();
  const byId = new Map(), conflicts = new Set(), contextsById = new Map();
  let fencedOperationCount = 0;
  for (const operation of operations) {
    if (operation.kind === 'clear') continue;
    const rows = operation.kind === 'checkpoint' ? operation.rows
      : operation.entries.map(entry => ({ entry, contexts: [operation.clearIds] }));
    for (const { entry, contexts } of rows) {
      const eligible = contexts.filter(context => clearIds.every(id => context.includes(id)));
      if (!eligible.length) { fencedOperationCount += 1; continue; }
      const old = byId.get(entry.eventId);
      if (old && !same(old, entry)) conflicts.add(entry.eventId);
      else byId.set(entry.eventId, entry);
      const original = contextsById.get(entry.eventId) || new Map();
      for (const context of eligible) original.set(JSON.stringify([...context].sort()), [...context].sort());
      contextsById.set(entry.eventId, original);
    }
  }
  const entries = [...byId.values()].filter(entry => !conflicts.has(entry.eventId))
    .sort((a, b) => b.at - a.at || a.eventId.localeCompare(b.eventId)).slice(0, 500);
  const rows = entries.map(entry => ({ entry, contexts: [...contextsById.get(entry.eventId).values()] }));
  return Object.freeze({ version: 1, entries, rows, clearIds, legacyImportIds,
    viewScope: 'confirmed-discovered-operations', globallyFresh: false,
    discoveredOperationCount: operations.length, unresolvedKeys: [...unresolvedKeys],
    fencedOperationCount, conflictingEventIds: [...conflicts].sort(),
  });
}


/**
 * Private, actor-bound history only. Immutable acknowledged operations avoid
 * overwriting another instance's history. Discovery is never a freshness/CAS
 * claim. The 500 bound is the visible/exported view, not all backing storage.
 */
export function createPresenceHistoryJournal({
  accountKey, readLegacy, storage, randomId = secureId, hash = contentHash,
  now = Date.now, timeoutMs = 10_000,
} = {}) {
  if (typeof accountKey !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(accountKey)
    || typeof readLegacy !== 'function' || typeof randomId !== 'function'
    || typeof hash !== 'function' || typeof now !== 'function'
    || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000
    || ['getValue', 'listValues', 'setValue', 'deleteValue', 'listen', 'unlisten']
      .some(name => typeof storage?.[name] !== 'function')) throw failure('history-adapter-unavailable');
  const actor = accountKey;
  const known = new Map(), pending = new Map(), issued = new Set(), listeners = new Set();
  const cleanupUncertain = new Set();
  let unresolved = [], tail = Promise.resolve(), latest = Promise.resolve();
  let initialized = false, loading = false, clearing = false, readFailed = false;
  let disposed = false, refreshing = null, compacting = null, remoteClearRevision = 0;
  let applied = new Set();

  const view = () => reduceView(known, actor, unresolved);
  const pendingRelevant = () => {
    const fences = view().clearIds;
    return [...pending.values()].filter(item => ['append', 'clear'].includes(item.operation.kind)
      && (item.operation.kind === 'clear' || fences.every(id => item.operation.clearIds.includes(id))));
  };
  const snapshot = () => {
    const current = view(), waiting = pendingRelevant();
    return clone({ version: 1, entries: current.entries, history: {
      initialized, loading, saving: waiting.some(item => !item.failed),
      clearing, error: readFailed || waiting.some(item => item.failed),
      pendingCount: waiting.length, unresolvedCount: unresolved.length + cleanupUncertain.size,
      conflictCount: current.conflictingEventIds.length, scope: 'confirmed-discovered',
      globallyFresh: false, remoteClearRevision,
    } });
  };
  function publish() {
    const next = new Set(view().clearIds);
    for (const id of next) if (!applied.has(id) && !issued.has(id)) remoteClearRevision += 1;
    applied = next;
    if (disposed) return;
    const value = snapshot();
    for (const listener of listeners) { try { listener(value); } catch { /* A view cannot authorize or abort storage work. */ } }
  }
  const alive = signal => {
    if (disposed || signal.aborted) throw failure('history-operation-interrupted');
  };
  function awaitSignal(value, signal) {
    if (signal.aborted) { void Promise.resolve(value).catch(() => {}); return Promise.reject(failure('history-operation-timeout')); }
    return new Promise((resolve, reject) => {
      const abort = () => { signal.removeEventListener('abort', abort); reject(failure('history-operation-timeout')); };
      signal.addEventListener('abort', abort, { once: true });
      Promise.resolve(value).then(result => {
        signal.removeEventListener('abort', abort);
        if (signal.aborted) reject(failure('history-operation-timeout')); else resolve(result);
      }, error => { signal.removeEventListener('abort', abort); reject(error); });
    });
  }
  async function call(name, args, signal) {
    alive(signal);
    const result = storage[name](...args);
    if (!result || typeof result.then !== 'function') throw failure('history-acknowledged-adapter-required');
    const value = await awaitSignal(result, signal);
    alive(signal);
    return value;
  }
  function schedule(operation) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const result = tail.then(() => { alive(controller.signal); return operation(controller.signal); });
    tail = result.catch(() => {});
    const bounded = awaitSignal(result, controller.signal).finally(() => clearTimeout(timer));
    void bounded.catch(() => {});
    return bounded;
  }
  function checkGuard(guard) {
    if (guard === undefined) return;
    if (typeof guard !== 'function') throw failure('history-account-changed');
    const result = guard();
    if (result !== true) {
      if (result && typeof result.then === 'function') void Promise.resolve(result).catch(() => {});
      throw failure('history-account-changed');
    }
  }
  function operation(kind, entries = []) {
    const id = randomId();
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw failure('history-operation-id-invalid');
    return { version: 1, actor, id, kind,
      clearIds: [...new Set([...view().clearIds, ...issued])].sort(),
      entries: normalizePresenceActivityLog({ entries }).entries };
  }
  function prepare(value, guard) {
    const key = prefix(actor) + value.id;
    const clean = validOperation(key, value, actor);
    if (!clean) throw failure('history-operation-invalid');
    checkGuard(guard);
    const existing = pending.get(key);
    if (existing && !same(existing.operation, clean)) throw failure('history-operation-retry-changed');
    const item = existing || { operation: clean, failed: false };
    pending.set(key, item);
    if (clean.kind === 'clear') issued.add(clean.id);
    return { key, item, guard };
  }
  async function commitInside(prepared, signal) {
    const { key, item, guard } = prepared;
    let dispatched = false;
    try {
      alive(signal);
      checkGuard(guard); // No await between fresh actor proof and dispatch.
      dispatched = true;
      prepared.dispatched = true;
      item.failed = false;
      await call('setValue', [key, clone(item.operation)], signal);
      known.set(key, clone(item.operation));
      pending.delete(key);
      publish();
      // Notice is an optional discovery hint, never a canonical record or receipt.
      try {
        const hint = storage.setValue(noticeKey(actor), { version: 1, operationKey: key });
        void Promise.resolve(hint).catch(() => {});
      } catch { /* The immutable operation is already acknowledged. */ }
      return { operationId: item.operation.id, acknowledged: true,
        fenced: item.operation.kind !== 'clear' && !view().clearIds.every(id => item.operation.clearIds.includes(id)),
        view: snapshot() };
    } catch (error) {
      if (!dispatched && item.operation.kind === 'clear') {
        pending.delete(key); issued.delete(item.operation.id);
      } else item.failed = true;
      publish();
      throw error;
    }
  }
  function submit(value, guard) {
    let prepared;
    try { prepared = prepare(value, guard); }
    catch (error) { return Promise.reject(error); }
    publish();
    const result = schedule(signal => commitInside(prepared, signal));
    void result.catch(() => { prepared.item.failed = true; publish(); });
    return result;
  }
  async function discoverInside(signal) {
    const keys = await call('listValues', [], signal);
    if (!Array.isArray(keys) || keys.some(key => typeof key !== 'string')) throw failure('history-discovery-invalid');
    const missing = [];
    for (const key of keys) {
      if (!key.startsWith(prefix(actor)) || pending.has(key)) continue;
      const value = await call('getValue', [key, null], signal);
      const clean = validOperation(key, value, actor);
      if (!clean) { missing.push(key); continue; }
      const old = known.get(key);
      if (old && !same(old, clean)) { missing.push(key); continue; }
      known.set(key, clean);
    }
    unresolved = missing;
    alive(signal);
  }
  async function importInside(signal) {
    const record = await awaitSignal(readLegacy(), signal);
    alive(signal);
    const entries = normalizePresenceActivityLog(record).entries;
    const id = 'baseline_' + await awaitSignal(hash(entries), signal);
    alive(signal);
    if (!/^baseline_[a-f0-9]{64}$/.test(id)) throw failure('history-hash-invalid');
    if (view().legacyImportIds.includes(id)) return;
    // Import is always original generation, including after Clear/reload.
    await commitInside(prepare({ version: 1, actor, id, kind: 'baseline', clearIds: [], entries }), signal);
  }
  async function retryInside(signal) {
    for (const [key, item] of [...pending]) {
      if (item.operation.kind !== 'append' || !item.failed) continue;
      if (!view().clearIds.every(id => item.operation.clearIds.includes(id))) { pending.delete(key); continue; }
      await commitInside({ key, item }, signal);
    }
  }
  function refresh({ retryPending = false } = {}) {
    if (refreshing) return refreshing;
    loading = true; publish();
    refreshing = schedule(async signal => {
      await discoverInside(signal);
      await importInside(signal);
      if (retryPending) await retryInside(signal);
      alive(signal);
      initialized = true; readFailed = false;
      return snapshot();
    }).catch(error => { readFailed = true; throw error; }).finally(() => {
      loading = false; refreshing = null; publish();
    }).then(() => snapshot());
    void refreshing.catch(() => {});
    return refreshing;
  }
  function append(entries) {
    if (!Array.isArray(entries) || !entries.length || entries.length > 500) return Promise.reject(failure('history-entry-invalid'));
    const normalized = normalizePresenceActivityLog({ entries }).entries;
    if (normalized.length !== entries.length) return Promise.reject(failure('history-entry-invalid'));
    const value = operation('append', normalized); // Capture original context before queue wait.
    latest = submit(value);
    void latest.then(() => { if (known.size > 64) void compact().catch(() => {}); }, () => {});
    return latest;
  }
  function clear({ beforeCommit } = {}) {
    if (clearing) return Promise.reject(failure('history-clear-pending'));
    let prepared;
    try { prepared = prepare(operation('clear'), beforeCommit); }
    catch (error) { return Promise.reject(error); }
    clearing = true; publish();
    latest = schedule(signal => commitInside(prepared, signal)).catch(error => {
      if (!prepared.dispatched) { pending.delete(prepared.key); issued.delete(prepared.item.operation.id); }
      throw error;
    }).finally(() => { clearing = false; publish(); });
    void latest.catch(() => {});
    return latest;
  }
  async function compactInside(signal) {
    const before = view(), conflicts = new Set(before.conflictingEventIds);
    const candidates = [...known].filter(([, value]) => value.kind !== 'clear'
      && !(value.kind === 'checkpoint' ? value.rows.map(row => row.entry) : value.entries)
        .some(entry => conflicts.has(entry.eventId))).slice(0, 32);
    if (!candidates.length) return snapshot();
    const value = operation('checkpoint');
    value.clearIds = [...before.clearIds];
    value.rows = clone(before.rows);
    value.legacyImportIds = [...before.legacyImportIds];
    value.covers = [];
    for (const [key, covered] of candidates) {
      const fingerprint = await awaitSignal(hash(covered), signal);
      alive(signal);
      if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw failure('history-hash-invalid');
      value.covers.push({ key, hash: fingerprint });
    }
    await commitInside(prepare(value), signal);
    // The acknowledged checkpoint establishes logical 500-entry retirement.
    // Physical deletion is separate and may fail/settle indeterminately.
    const cleanup = [];
    const currentConflicts = new Set(view().conflictingEventIds);
    for (const ref of value.covers) {
      const covered = known.get(ref.key);
      if (!covered || covered.kind === 'clear') continue;
      const fingerprint = await awaitSignal(hash(covered), signal);
      alive(signal);
      const rows = covered.kind === 'checkpoint' ? covered.rows.map(row => row.entry) : covered.entries;
      if (fingerprint !== ref.hash || rows.some(entry => currentConflicts.has(entry.eventId))) continue;
      cleanup.push(ref.key);
    }
    for (const key of cleanup) known.delete(key);
    publish();
    for (const key of cleanup) {
      try { await call('deleteValue', [key], signal); cleanupUncertain.delete(key); }
      catch (error) { cleanupUncertain.add(key); publish(); throw error; }
    }
    publish();
    return snapshot();
  }
  function compact() {
    if (compacting) return compacting;
    compacting = schedule(signal => compactInside(signal)).finally(() => { compacting = null; publish(); });
    void compacting.catch(() => {});
    return compacting;
  }
  const listenerId = storage.listen(noticeKey(actor), value => {
    if (disposed || value?.version !== 1 || typeof value.operationKey !== 'string'
      || !value.operationKey.startsWith(prefix(actor))) return;
    void refresh().catch(() => {});
  });
  return Object.freeze({
    refresh, append, clear, compact, snapshot,
    settled: () => latest,
    exportRecord() {
      const value = snapshot();
      return Object.freeze({ schemaVersion: 1, kind: 'insta-toolbox-presence-log',
        generatedAt: new Date(now()).toISOString(), entries: value.entries,
        historyScope: 'confirmed-discovered', globallyFresh: false,
        pendingActivityExcluded: value.history.pendingCount > 0 });
    },
    subscribe(listener) {
      if (typeof listener !== 'function') throw failure('presence-log-listener-required');
      listeners.add(listener); listener(snapshot());
      return () => listeners.delete(listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true; listeners.clear(); storage.unlisten(listenerId);
    },
  });
}
