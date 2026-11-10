import assert from 'node:assert/strict';
import test from 'node:test';
import { createPresenceHistoryJournal } from '../extension/presence-history-journal.js';
import { HistoryManager, hashHistoryValue, historyActor, historyRow, legacyHistory, tickHistory } from './helpers/presence-history-storage.js';

function fixture(manager, name, actor = historyActor, options = {}) {
  const client = manager.open(name);
  const journal = createPresenceHistoryJournal({ accountKey: actor, storage: client.storage,
    readLegacy: () => client.readLegacy(actor), randomId: client.randomId, hash: hashHistoryValue, ...options });
  return { client, journal };
}
const entries = journal => journal.snapshot().entries;
const ids = journal => entries(journal).map(entry => entry.eventId);
const runRows = name => ['started', 'action', 'completed'].map((phase, index) => historyRow(name + '_' + phase, 1_800_000_000_000 + index));
const currentReader = async (manager, name = 'reader') => {
  const result = fixture(manager, name); await result.journal.refresh(); return result;
};

test('private immutable operations preserve95+A3+B3 across separate stale caches and a closed acknowledged writer', async () => {
  const manager = new HistoryManager(); manager.seed();
  const a = fixture(manager, 'a'), b = fixture(manager, 'b');
  const first = await a.journal.refresh(); await b.journal.refresh();
  assert.equal(first.history.initialized, true); assert.equal(first.history.loading, false);
  await a.journal.append(runRows('a')); a.journal.dispose(); a.client.close();
  assert.equal(entries(b.journal).length, 95);
  await b.journal.append(runRows('b'));
  assert.equal(entries(b.journal).length, 98);
  const fresh = await currentReader(manager);
  assert.equal(entries(fresh.journal).length, 101);
  b.client.deliverRemote(); await b.journal.refresh();
  assert.equal(entries(b.journal).length, 101);
  assert.equal(b.journal.snapshot().history.globallyFresh, false);
  assert.deepEqual(manager.values.get('instaToolboxPresenceActivityLogV1:' + historyActor), legacyHistory);
});

test('a failed append is retried with its captured operation key and cannot clobber another actor or tab', async () => {
  const manager = new HistoryManager(); manager.seed(); manager.seed('fixture_key_b');
  const a = fixture(manager, 'a'), b = fixture(manager, 'b'), other = fixture(manager, 'other', 'fixture_key_b');
  await a.journal.refresh(); await b.journal.refresh(); await other.journal.refresh();
  let failedKey;
  manager.beforeSet = (key, value, name) => {
    if (!failedKey && name === 'a' && value.kind === 'append') { failedKey = key; throw new Error('fixture-failure'); }
  };
  await assert.rejects(a.journal.append(runRows('a')), /fixture-failure/);
  assert.equal(a.journal.snapshot().history.pendingCount, 1);
  await b.journal.append(runRows('b')); await other.journal.append([historyRow('other_only')]);
  a.client.deliverRemote(); await a.journal.refresh({ retryPending: true });
  assert.equal(entries(a.journal).length, 101);
  assert.equal(manager.calls.filter(call => call.key === failedKey && call.kind === 'set').length, 2);
  const otherFresh = fixture(manager, 'other_fresh', 'fixture_key_b'); await otherFresh.journal.refresh();
  assert.equal(entries(otherFresh.journal).length, 96); assert.equal(ids(otherFresh.journal).includes('a_action'), false);
});

test('Clear fences queued old writes and legacy reimport while local post-Clear capture survives a delayedACK', async () => {
  const manager = new HistoryManager(); manager.seed(); const a = fixture(manager, 'a'), stale = fixture(manager, 'stale');
  await a.journal.refresh(); await stale.journal.refresh();
  let release, clearSeen = false;
  const gate = new Promise(resolve => { release = resolve; });
  manager.afterSet = async (_key, value, name) => { if (name === 'a' && value.kind === 'clear') { clearSeen = true; await gate; } };
  const clearing = a.journal.clear({ beforeCommit: () => true });
  await tickHistory(); assert.equal(clearSeen, true);
  let appended = false;
  const after = a.journal.append([historyRow('after_local_clear')]).then(value => { appended = true; return value; });
  await stale.journal.append([historyRow('stale_old_generation')]);
  await tickHistory(); assert.equal(appended, false); assert.equal(entries(a.journal).length, 95);
  release(); await clearing; await after;
  const loaded = await currentReader(manager);
  assert.deepEqual(ids(loaded.journal), ['after_local_clear']);
  await loaded.journal.compact(); loaded.journal.dispose(); loaded.client.close();
  const reloaded = await currentReader(manager, 'reloaded');
  assert.deepEqual(ids(reloaded.journal), ['after_local_clear']);
  assert.deepEqual(manager.values.get('instaToolboxPresenceActivityLogV1:' + historyActor), legacyHistory);
});

test('failed or async current-actor guards create no Clear operation or future generation state', async () => {
  for (const beforeCommit of [() => false, () => Promise.resolve(true), async () => { throw new Error('bad guard'); }]) {
    const manager = new HistoryManager(); manager.seed(); const a = fixture(manager, 'a'); await a.journal.refresh();
    const count = manager.calls.length;
    await assert.rejects(a.journal.clear({ beforeCommit }));
    await tickHistory(); assert.equal(manager.calls.length, count);
    assert.equal(a.journal.snapshot().history.pendingCount, 0);
    await a.journal.append([historyRow('ordinary_after_cancel')]);
    const delta = manager.calls.findLast(call => call.value?.kind === 'append');
    assert.deepEqual(delta.value.clearIds, []);
  }
});

test('an actor change while Clear waits in the writer queue revokes it before dispatch', async () => {
  const manager = new HistoryManager(); manager.seed(); const a = fixture(manager, 'a'); await a.journal.refresh();
  let owner = true, release;
  const gate = new Promise(resolve => { release = resolve; });
  manager.afterSet = async (_key, value) => { if (value.kind === 'append') await gate; };
  const append = a.journal.append([historyRow('in_flight')]);
  await tickHistory(); const clear = a.journal.clear({ beforeCommit: () => owner });
  owner = false; release(); await append;
  await assert.rejects(clear, /account-changed/);
  assert.equal(manager.calls.some(call => call.value?.kind === 'clear'), false);
  assert.equal(a.journal.snapshot().history.pendingCount, 0);
  manager.afterSet = null; await a.journal.append([historyRow('after_rejected_clear')]);
  assert.deepEqual(manager.calls.findLast(call => call.value?.kind === 'append').value.clearIds, []);
});

test('known conflicting event payloads survive checkpointing and replay until explicit Clear', async () => {
  const manager = new HistoryManager(); manager.seed(); const a = fixture(manager, 'a'); await a.journal.refresh();
  await a.journal.append([historyRow('conflict')]);
  await a.journal.append([{ ...historyRow('conflict'), detail: 'Conflicting synthetic detail' }]);
  const affectedKeys = manager.calls.filter(call => call.value?.entries?.some(entry => entry.eventId === 'conflict')).map(call => call.key);
  await a.journal.compact();
  assert.equal(a.journal.snapshot().history.conflictCount, 1);
  assert.ok(affectedKeys.every(key => manager.values.has(key)));
  const fresh = await currentReader(manager); assert.equal(fresh.journal.snapshot().history.conflictCount, 1);
  assert.equal(ids(fresh.journal).includes('conflict'), false);
  await fresh.journal.clear({ beforeCommit: () => true }); await fresh.journal.compact();
  assert.equal(fresh.journal.snapshot().history.conflictCount, 0); assert.equal(entries(fresh.journal).length, 0);
});

test('checkpointACK precedes logical retirement and GC keeps queued append/discovery behind everyDELETEACK', async () => {
  const manager = new HistoryManager(); const a = fixture(manager, 'a'); await a.journal.refresh();
  await a.journal.append([historyRow('older_pruned', 1_700_000_000_000)]);
  await a.journal.append(Array.from({ length: 500 }, (_, i) => historyRow('retained_' + i, 1_800_000_000_000 + i)));
  const olderKey = manager.calls.find(call => call.value?.entries?.some(entry => entry.eventId === 'older_pruned')).key;
  let cpRelease, deleteRelease, deleting = false;
  const checkpointGate = new Promise(resolve => { cpRelease = resolve; });
  const deleteGate = new Promise(resolve => { deleteRelease = resolve; });
  manager.afterSet = async (_key, value) => { if (value.kind === 'checkpoint') await checkpointGate; };
  manager.afterDelete = async key => { if (key === olderKey) { deleting = true; await deleteGate; } };
  const compacting = a.journal.compact(); await tickHistory();
  assert.equal(manager.calls.some(call => call.kind === 'delete'), false);
  cpRelease(); await tickHistory(); assert.equal(deleting, true);
  let appended = false, discovered = false;
  const q = a.journal.append([{ ...historyRow('older_pruned', 1_800_000_999_999), detail: 'Later serialized payload' }])
    .then(value => { appended = true; return value; });
  const d = a.journal.refresh().then(value => { discovered = true; return value; });
  await tickHistory(); assert.equal(appended, false); assert.equal(discovered, false);
  assert.equal(a.journal.snapshot().history.conflictCount, 0);
  deleteRelease(); await compacting; await q; await d;
  assert.equal(entries(a.journal).length, 500);
});

for (const phase of ['before', 'after']) test('indeterminate GC deletion rejection ' + phase + ' physical deletion preserves the ACKed view and queue boundary', async () => {
  const manager = new HistoryManager(); const a = fixture(manager, 'a'); await a.journal.refresh();
  await a.journal.append([historyRow('old_delete', 1_700_000_000_000)]);
  await a.journal.append(Array.from({ length: 500 }, (_, i) => historyRow('current_' + i, 1_800_000_000_000 + i)));
  const oldKey = manager.calls.find(call => call.value?.entries?.some(entry => entry.eventId === 'old_delete')).key;
  let release, reached = false;
  const gate = new Promise(resolve => { release = resolve; });
  manager[phase === 'before' ? 'beforeDelete' : 'afterDelete'] = async key => {
    if (key === oldKey) { reached = true; await gate; throw new Error('indeterminate fixture delete'); }
  };
  const compacting = a.journal.compact(); await tickHistory(); assert.equal(reached, true);
  let appended = false;
  const q = a.journal.append([{ ...historyRow('old_delete', 1_800_000_999_999), detail: 'Later queued payload' }])
    .then(value => { appended = true; return value; });
  await tickHistory(); assert.equal(appended, false);
  release(); await assert.rejects(compacting, /indeterminate fixture delete/); await q;
  assert.ok(a.journal.snapshot().history.unresolvedCount > 0);
  assert.equal(a.journal.snapshot().history.conflictCount, 0, 'retired old cache cannot create a quarantine that vanishes at rest');
  const fresh = await currentReader(manager);
  assert.equal(entries(fresh.journal).length, 500);
  assert.ok(ids(fresh.journal).includes('current_499'));
  assert.equal(fresh.journal.snapshot().history.conflictCount, phase === 'before' ? 1 : 0);
  assert.deepEqual(manager.values.get('instaToolboxPresenceActivityLogV1:' + historyActor), undefined);
});

test('a bounded initial read failure never mutates confirmed state after its deadline and can be retried explicitly', async () => {
  const manager = new HistoryManager(); manager.seed(); const a = fixture(manager, 'a', historyActor, { timeoutMs: 20 });
  const original = a.client.storage.listValues; let release;
  a.client.storage.listValues = () => new Promise(resolve => { release = resolve; });
  await assert.rejects(a.journal.refresh(), /timeout/);
  assert.equal(a.journal.snapshot().history.initialized, false);
  assert.equal(a.journal.snapshot().history.loading, false);
  release([...manager.values.keys()]); await tickHistory();
  assert.equal(entries(a.journal).length, 0);
  a.client.storage.listValues = original; await a.journal.refresh();
  assert.equal(entries(a.journal).length, 95); assert.equal(a.journal.snapshot().history.initialized, true);
});

test('concurrent Clear barriers join and only a newly observed joined generation can add visible history', async () => {
  const manager = new HistoryManager(); manager.seed(); const a = fixture(manager, 'a'), b = fixture(manager, 'b');
  await a.journal.refresh(); await b.journal.refresh();
  await a.journal.clear({ beforeCommit: () => true }); await b.journal.clear({ beforeCommit: () => true });
  await a.journal.append([historyRow('only_a_clear')]); await b.journal.append([historyRow('only_b_clear')]);
  const fresh = await currentReader(manager);
  assert.equal(entries(fresh.journal).length, 0);
  await fresh.journal.append([historyRow('joined_clear_context')]);
  assert.deepEqual(ids(fresh.journal), ['joined_clear_context']);
  const delta = manager.calls.findLast(call => call.value?.kind === 'append');
  assert.equal(delta.value.clearIds.length, 2);
});

test('checkpointed entries retain original fences when their referenced Clear arrives after the entry', async () => {
  const manager = new HistoryManager(); manager.seed(); const a = fixture(manager, 'a'), b = fixture(manager, 'b');
  await a.journal.refresh(); await b.journal.refresh();
  const clear = await b.journal.clear({ beforeCommit: () => true });
  await b.journal.append([historyRow('observed_b_clear')]);
  const delta = manager.calls.findLast(call => call.name === 'b' && call.value?.kind === 'append');
  a.client.cache.set(delta.key, structuredClone(delta.value));
  await a.journal.refresh(); await a.journal.compact();
  const checkpoint = manager.calls.findLast(call => call.name === 'a' && call.value?.kind === 'checkpoint');
  const retained = checkpoint.value.rows.find(row => row.entry.eventId === 'observed_b_clear');
  assert.deepEqual(retained.contexts, [[clear.operationId]]);
  a.client.deliverRemote(); await a.journal.refresh();
  assert.deepEqual(ids(a.journal), ['observed_b_clear']);
});

test('empty and stale concurrent checkpoints retain every applied Clear and legacy import marker', async () => {
  const manager = new HistoryManager(); manager.seed(); const a = fixture(manager, 'a'), b = fixture(manager, 'b');
  await a.journal.refresh(); await b.journal.refresh();
  const clear = await a.journal.clear({ beforeCommit: () => true });
  const clearKey = manager.calls.find(call => call.value?.id === clear.operationId).key;
  await a.journal.compact(); await b.journal.compact();
  const reader = fixture(manager, 'missing_direct_clear'); reader.client.cache.delete(clearKey);
  await reader.journal.refresh(); assert.equal(entries(reader.journal).length, 0);
  assert.equal(manager.calls.filter(call => call.name === 'missing_direct_clear' && call.value?.kind === 'baseline').length, 0);
  await reader.journal.append([historyRow('after_checkpoint_clear')]);
  assert.deepEqual(ids(reader.journal), ['after_checkpoint_clear']);
});

test('GC deletes at most32 exact covered keys and never an operation omitted by its stale discovery', async () => {
  const manager = new HistoryManager(); manager.seed(); const a = fixture(manager, 'a'), unseen = fixture(manager, 'unseen');
  await a.journal.refresh(); await unseen.journal.refresh();
  for (let batch = 0; batch < 31; batch += 1) {
    await a.journal.append(Array.from({ length: 20 }, (_, i) => historyRow('batch_' + batch + '_' + i, 1_800_000_010_000 + batch * 20 + i)));
  }
  await unseen.journal.append([historyRow('unknown_newest', 1_800_000_999_999)]);
  const unknownKey = manager.calls.findLast(call => call.name === 'unseen' && call.value?.kind === 'append').key;
  const before = ids(a.journal); assert.equal(before.length, 500);
  const deletes = manager.calls.filter(call => call.kind === 'delete').length;
  await a.journal.compact();
  assert.ok(manager.calls.filter(call => call.kind === 'delete').length - deletes <= 32);
  assert.ok(manager.values.has(unknownKey)); assert.deepEqual(ids(a.journal), before);
  const fresh = await currentReader(manager); assert.ok(ids(fresh.journal).includes('unknown_newest'));
});

test('checkpoint write failure cannot delete source operations or overwrite the legacy backup', async () => {
  const manager = new HistoryManager(); manager.seed(); const a = fixture(manager, 'a'); await a.journal.refresh();
  await a.journal.append([historyRow('saved_before_checkpoint')]);
  manager.beforeSet = (_key, value) => { if (value.kind === 'checkpoint') throw new Error('checkpoint rejected'); };
  await assert.rejects(a.journal.compact(), /checkpoint rejected/);
  assert.equal(manager.calls.some(call => call.kind === 'delete'), false);
  assert.equal(ids(a.journal).includes('saved_before_checkpoint'), true);
  const fresh = await currentReader(manager); assert.equal(ids(fresh.journal).includes('saved_before_checkpoint'), true);
  assert.deepEqual(manager.values.get('instaToolboxPresenceActivityLogV1:' + historyActor), legacyHistory);
});

test('invalid and unresolved discovered operations cannot authorize GC or promote a legacy import into a new generation', async () => {
  const manager = new HistoryManager(); manager.seed();
  const base = 'instaToolboxPresenceActivityLogV1:' + historyActor + ':journal:v1:op:';
  const invalid = base + 'invalid_actor', unresolved = base + 'unresolved_value';
  const retagged = base + 'baseline_' + 'a'.repeat(64);
  manager.values.set(invalid, { version: 1, actor: 'another_owner', id: 'invalid_actor', kind: 'append', clearIds: [], entries: [historyRow('must_not_accept')] });
  manager.values.set(unresolved, null);
  manager.values.set(retagged, { version: 1, actor: historyActor, id: 'baseline_' + 'a'.repeat(64), kind: 'baseline',
    clearIds: ['invented_generation'], entries: [historyRow('retagged_legacy')] });
  const a = fixture(manager, 'a'); await a.journal.refresh();
  assert.equal(a.journal.snapshot().history.unresolvedCount, 3);
  assert.equal(ids(a.journal).includes('must_not_accept'), false); assert.equal(ids(a.journal).includes('retagged_legacy'), false);
  await a.journal.compact();
  assert.ok([invalid, unresolved, retagged].every(key => manager.values.has(key)));
  assert.equal(manager.calls.some(call => call.kind === 'delete' && [invalid, unresolved, retagged].includes(call.key)), false);
});
