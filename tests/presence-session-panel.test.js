import assert from 'node:assert/strict';
import test from 'node:test';
import { mountPresenceSessionPanel } from '../extension/presence-session-panel.js';

class Element {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.value = '';
    this.checked = false;
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return (this.text || '') + this.children.map(child => child.textContent).join(''); }
  set value(value) {
    const text = String(value);
    this.selectedValue = this.tagName === 'select'
      ? this.children.some(option => option.value === text) ? text : '' : text;
  }
  get value() { return this.selectedValue || ''; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.text = ''; this.children = [...nodes]; }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  removeEventListener(type) { this.listeners.delete(type); }
  remove() {}
  all() { return this.children.flatMap(child => [child, ...child.all()]); }
  fire(type) { return this.listeners.get(type)?.(); }
  click() { return this.fire('click'); }
}

function fixture({ confirm = async ({ binding }) => binding, saved = null, ...panelOptions } = {}) {
  const document = { createElement: tag => new Element(tag), createTextNode: text => {
    const node = new Element('#text'); node.textContent = text; return node;
  } };
  const container = document.createElement('div');
  const starts = [];
  const messages = [];
  let reviewSequence = 0;
  let preferences = saved || { actions: { likePosts: true }, mode: 'session', maxActions: 10 };
  let snapshot = { status: 'idle', results: [], completed: 0 };
  const session = {
    snapshot: () => snapshot,
    createReview: value => ({ ...value, reviewedDigest: `fixture-review-${++reviewSequence}` }),
    start: async review => {
      starts.push(review);
      snapshot = { status: 'completed', completed: 1, maxActions: review.options.maxActions, results: [] };
      return snapshot;
    },
    stop: () => false,
  };
  const panel = mountPresenceSessionPanel({ container, document, session,
    window: {}, now: () => 1_800_000_000_000,
    inspectAccount: () => ({ accountVerified: true, usable: true, accountId: 'fixture_owner', accountKey: 'fixture-key-owner' }),
    confirmAction: confirm,
    readPreferences: () => preferences,
    writePreferences: value => { preferences = value; },
    onStatus: message => messages.push(message),
    ...panelOptions,
  });
  const attr = name => container.all().find(node => node.attributes.has(name));
  const start = () => attr('data-presence-start');
  return { panel, session, document, container, attr, starts, messages, start,
    preferences: () => preferences,
    render: value => { snapshot = value; panel.render(value); },
  };
}

function scopedHistoryFixture(initialActor = null, { size = 90, window = {}, onAccountReady = () => {} } = {}) {
  let actor = initialActor;
  const actors = Object.fromEntries(['a', 'b'].map(name => [name, {
    accountVerified: true, usable: true, accountId: `fixture_owner_${name}`, accountKey: `fixture-key-${name}`,
  }]));
  const original = Object.fromEntries(['a', 'b'].map(name => [name, { version: 1,
    entries: Array.from({ length: size }, (_, index) => ({ eventId: `${name}:retained:${index}`,
      at: 1_700_000_000_000 + index, kind: 'action', action: 'likePosts', target: `${name} Fixture post ${index}`,
      outcome: 'completed', detail: 'Post liked' })) }]));
  const stores = new Map(['a', 'b'].map(name => [actors[name].accountKey, structuredClone(original[name])]));
  const writes = [];
  const reads = [], hooks = {};
  const f = fixture({ inspectAccount: () => actor ? actors[actor] : { accountVerified: false, usable: false },
    window, onAccountReady,
    readLog: accountKey => {
      reads.push(accountKey);
      if (hooks.read) return hooks.read(accountKey);
      return structuredClone(stores.get(accountKey));
    },
    writeLog(value, accountKey) {
      if (!accountKey) throw new Error('presence-log-account-unverified');
      writes.push({ key: accountKey, value: structuredClone(value) });
      if (hooks.write) return hooks.write(value, accountKey);
      stores.set(accountKey, structuredClone(value));
    } });
  window.document = f.document;
  return { ...f, writes, reads, hooks, window, original, actors, stores, setActor: value => { actor = value; } };
}

const settleHistoryWrites = () => new Promise(resolve => setImmediate(resolve));
const retainedHistoryIds = entries => new Set(entries.map(entry => entry.eventId));
const historyControl = (f, label) => f.container.all().find(node => node.tagName === 'button' && node.textContent === label);
const showHistory = f => {
  const details = f.container.all().find(node => node.className === 'presence-log');
  details.open = true; details.fire('toggle');
};
const downloadWindow = () => {
  const blobs = [];
  return { blobs, window: { Blob, setTimeout: () => 0, URL: {
    createObjectURL(blob) { blobs.push(blob); return 'blob:fixture-history'; }, revokeObjectURL() {},
  } } };
};

const deferredHistory = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

// A controllable public journal interface isolates panel state and async guards.
// The separate journal suite validates real persistence and multi-tab semantics.
function historyBackend(entries = []) {
  const listeners = new Set(), failed = [];
  const calls = { refresh: [], clear: 0, committedClear: 0, append: 0, disposed: 0 };
  const hooks = {};
  let record = { version: 1, entries: structuredClone(entries), history: {
    initialized: false, loading: false, saving: false, clearing: false, error: false,
    pendingCount: 0, unresolvedCount: 0, conflictCount: 0, scope: 'confirmed-discovered',
    globallyFresh: false, remoteClearRevision: 0,
  } };
  let latest = Promise.resolve();
  const snapshot = () => structuredClone(record);
  const publish = () => { for (const listener of listeners) listener(snapshot()); };
  const merge = values => {
    const combined = new Map([...values, ...record.entries].map(entry => [entry.eventId, entry]));
    record.entries = [...combined.values()].sort((a, b) => b.at - a.at).slice(0, 500);
  };
  const journal = {
    snapshot,
    subscribe(listener) { listeners.add(listener); listener(snapshot()); return () => listeners.delete(listener); },
    refresh(options = {}) {
      calls.refresh.push({ ...options }); record.history.loading = true; publish();
      return Promise.resolve().then(() => hooks.refresh?.(options)).then(() => {
        if (options.retryPending) {
          for (const values of failed.splice(0)) merge(values);
          record.history.pendingCount = 0; record.history.saving = false;
        }
        record.history.loading = false; record.history.initialized = true; record.history.error = false; publish();
        return snapshot();
      }, error => { record.history.loading = false; record.history.error = true; publish(); throw error; });
    },
    append(values) {
      calls.append += 1; record.history.pendingCount += 1; record.history.saving = true; publish();
      latest = Promise.resolve().then(() => hooks.append?.(values)).then(() => {
        merge(values); record.history.pendingCount -= 1;
        record.history.saving = record.history.pendingCount > 0; record.history.error = false; publish();
        return { view: snapshot() };
      }, error => { failed.push(structuredClone(values)); record.history.error = true; publish(); throw error; });
      return latest;
    },
    clear({ beforeCommit }) {
      calls.clear += 1;
      latest = Promise.resolve().then(() => hooks.beforeClear?.()).then(async () => {
        if (beforeCommit() !== true) throw new Error('history-account-changed');
        calls.committedClear += 1; record.history.clearing = true; publish();
        await hooks.clearAck?.();
        record.entries = []; record.history.clearing = false; record.history.error = false; publish();
        return { view: snapshot() };
      }).catch(error => { record.history.clearing = false; record.history.error = true; publish(); throw error; });
      return latest;
    },
    settled: () => latest,
    exportRecord() { return { schemaVersion: 1, kind: 'insta-toolbox-presence-log',
      generatedAt: new Date(1_800_000_000_000).toISOString(), entries: snapshot().entries,
      historyScope: 'confirmed-discovered', globallyFresh: false,
      pendingActivityExcluded: record.history.pendingCount > 0 }; },
    dispose() { calls.disposed += 1; listeners.clear(); },
  };
  return { journal, hooks, calls, update(history, nextEntries) {
    Object.assign(record.history, history); if (nextEntries) record.entries = structuredClone(nextEntries); publish();
  } };
}

const journalEntries = () => [{ eventId: 'retained-journal-row', at: 1_700_000_000_000,
  kind: 'action', action: 'likePosts', target: 'Retained synthetic post', outcome: 'completed', detail: 'Post liked' }];

test('journal history initializes once and Start waits for ready account history before confirmation', async () => {
  const backend = historyBackend(journalEntries()), gate = deferredHistory();
  backend.hooks.refresh = () => gate.promise;
  let confirmations = 0;
  const f = fixture({ createHistoryStore: () => backend.journal,
    confirm: async ({ binding }) => { confirmations += 1; return binding; } });
  assert.match(f.container.textContent, /Loading activity/);
  assert.equal(historyControl(f, 'Clear log').disabled, true);
  const pending = f.panel.begin(); await settleHistoryWrites();
  assert.equal(confirmations, 0); assert.equal(f.panel.busy(), true);
  assert.match(f.start().textContent, /Loading history/);
  assert.equal(backend.calls.refresh.length, 1);
  gate.resolve(); assert.equal(await pending, true); await settleHistoryWrites();
  assert.equal(confirmations, 1); assert.equal(f.starts.length, 1);
  assert.match(f.container.textContent, /up to 500.*Other tabs/);
  f.panel.dispose(); assert.equal(backend.calls.disposed, 1);
});

for (const drift of ['disposed', 'account', 'busy', 'options']) {
  test(`journal initialization cannot open confirmation after ${drift} changes`, async () => {
    const backend = historyBackend(), gate = deferredHistory(); backend.hooks.refresh = () => gate.promise;
    let owner = 'fixture_owner', busy = false, confirmations = 0;
    const f = fixture({ createHistoryStore: () => backend.journal, busy: () => busy,
      inspectAccount: () => ({ accountVerified: true, usable: true, accountId: owner, accountKey: `key-${owner}` }),
      confirm: async ({ binding }) => { confirmations += 1; return binding; } });
    const pending = f.panel.begin(); await settleHistoryWrites();
    if (drift === 'disposed') f.panel.dispose();
    if (drift === 'account') owner = 'other_owner';
    if (drift === 'busy') busy = true;
    if (drift === 'options') f.attr('data-presence-limit').value = '9';
    gate.resolve(); assert.equal(await pending, false);
    assert.equal(confirmations, 0); assert.equal(f.starts.length, 0);
    f.panel.dispose();
  });
}

test('an initial history failure settles without auto-Start and reopening actually retries', async () => {
  const backend = historyBackend(); backend.hooks.refresh = () => { throw new Error('private provider detail'); };
  let confirmations = 0;
  const f = fixture({ createHistoryStore: () => backend.journal,
    confirm: async ({ binding }) => { confirmations += 1; return binding; } });
  assert.equal(await f.panel.begin(), false);
  assert.equal(f.panel.busy(), false); assert.equal(f.start().disabled, false);
  assert.equal(f.container.all().find(node => node.className === 'presence-log').open, true);
  assert.equal(confirmations, 0); assert.doesNotMatch(f.container.textContent, /private provider detail/);
  backend.hooks.refresh = () => {};
  showHistory(f); await settleHistoryWrites();
  assert.equal(backend.calls.refresh.at(-1).retryPending, true);
  assert.equal(f.starts.length, 0, 'recovery never starts the abandoned request');
  assert.equal(await f.panel.begin(), true); f.panel.dispose();
});

test('failed journal activity stays quiet, preserves downloads and retries on an explicit reopen', async () => {
  const backend = historyBackend(journalEntries());
  backend.hooks.append = () => { throw new Error('write rejected'); };
  const downloads = downloadWindow();
  const f = fixture({ createHistoryStore: () => backend.journal, window: downloads.window });
  downloads.window.document = f.document;
  await settleHistoryWrites();
  assert.equal(await f.panel.begin(), true); await settleHistoryWrites();
  assert.equal(f.starts.length, 1); assert.match(f.messages.at(-1), /Presence finished/);
  assert.match(f.container.textContent, /Keep this tab open.*retry/);
  assert.match(f.container.textContent, /not included in downloads/);
  assert.equal(historyControl(f, 'Download log').disabled, false);
  historyControl(f, 'Download log').fire('click');
  const exported = JSON.parse(await downloads.blobs[0].text());
  assert.equal(exported.pendingActivityExcluded, true); assert.equal(exported.globallyFresh, false);
  assert.equal(exported.entries.length, 1);
  backend.hooks.append = () => {}; showHistory(f); await settleHistoryWrites();
  assert.equal(backend.calls.refresh.at(-1).retryPending, true);
  assert.equal(backend.journal.snapshot().history.pendingCount, 0);
  assert.ok(backend.journal.snapshot().entries.length > 1);
  f.panel.dispose();
});

test('two direct Start requests during history initialization produce only one review and run', async () => {
  const backend = historyBackend(), gate = deferredHistory(); backend.hooks.refresh = () => gate.promise;
  let confirmations = 0;
  const f = fixture({ createHistoryStore: () => backend.journal,
    confirm: async ({ binding }) => { confirmations += 1; return binding; } });
  const first = f.panel.begin(), second = f.panel.begin();
  assert.equal(await second, false); assert.equal(confirmations, 0);
  gate.resolve(); assert.equal(await first, true);
  assert.equal(confirmations, 1); assert.equal(f.starts.length, 1); f.panel.dispose();
});

test('journal Clear is explicit, blocks duplicates and announces success only after acknowledgement', async () => {
  const backend = historyBackend(journalEntries()), gate = deferredHistory(), confirmations = [];
  backend.hooks.clearAck = () => gate.promise;
  const f = fixture({ createHistoryStore: () => backend.journal,
    window: { confirm: text => { confirmations.push(text); return true; } } });
  await settleHistoryWrites();
  const pending = historyControl(f, 'Clear log').fire('click');
  await settleHistoryWrites();
  assert.equal(historyControl(f, 'Clear log').disabled, true);
  assert.match(f.container.textContent, /Clearing activity/);
  assert.doesNotMatch(f.container.textContent, /Activity log cleared\./);
  assert.equal(backend.journal.snapshot().entries.length, 1);
  await historyControl(f, 'Clear log').fire('click'); assert.equal(backend.calls.clear, 1);
  assert.match(confirmations[0], /also discards activity waiting to sync from other tabs/);
  assert.match(confirmations[0], /Tabs can add new activity after they receive the clear/);
  gate.resolve(); assert.equal(await pending, true);
  assert.match(f.container.textContent, /Activity log cleared\./);
  assert.equal(historyControl(f, 'Clear log').disabled, false, 'an empty confirmed view can clear waiting activity');
  assert.equal(historyControl(f, 'Download log').disabled, true); f.panel.dispose();
});

for (const drift of ['account', 'disposed']) {
  test(`queued journal Clear rechecks ${drift} immediately before dispatch`, async () => {
    const first = historyBackend(journalEntries()), second = historyBackend(), gate = deferredHistory();
    let actor = 'a'; first.hooks.beforeClear = () => gate.promise;
    const f = fixture({ createHistoryStore: key => key === 'key-a' ? first.journal : second.journal,
      inspectAccount: () => ({ accountVerified: true, usable: true, accountId: `owner_${actor}`, accountKey: `key-${actor}` }),
      window: { confirm: () => true } });
    await settleHistoryWrites(); const pending = historyControl(f, 'Clear log').fire('click');
    await settleHistoryWrites();
    if (drift === 'disposed') f.panel.dispose();
    else { actor = 'b'; f.panel.refreshLog(); }
    gate.resolve(); assert.equal(await pending, false);
    assert.equal(first.calls.committedClear, 0); assert.equal(second.calls.committedClear, 0);
    assert.equal(first.journal.snapshot().entries.length, 1);
    f.panel.dispose();
  });
}

test('a journal Clear failure retains the loaded view and never claims success', async () => {
  const backend = historyBackend(journalEntries()); backend.hooks.clearAck = () => { throw new Error('private-clear-error'); };
  const f = fixture({ createHistoryStore: () => backend.journal, window: { confirm: () => true } });
  await settleHistoryWrites(); assert.equal(await historyControl(f, 'Clear log').fire('click'), false);
  assert.equal(backend.journal.snapshot().entries.length, 1);
  assert.doesNotMatch(f.container.textContent, /Activity log cleared\.|private-clear-error/);
  assert.equal(historyControl(f, 'Download log').disabled, false);
  assert.deepEqual(f.messages, []); f.panel.dispose();
});

test('journal status reports reconciliation and remote Clear quietly without changing Presence progress', async () => {
  const backend = historyBackend(journalEntries());
  const f = fixture({ createHistoryStore: () => backend.journal }); await settleHistoryWrites();
  backend.update({ unresolvedCount: 1 });
  assert.match(f.container.textContent, /still being reconciled/);
  assert.doesNotMatch(f.container.textContent, /could not be saved/);
  backend.update({ unresolvedCount: 0, remoteClearRevision: 1 }, []);
  assert.match(f.container.textContent, /Activity log cleared in another tab/);
  assert.deepEqual(f.messages, []); f.panel.dispose();
});

test('log popup opens in the click before async refresh and blocked popups leave inline history usable', async () => {
  const backend = historyBackend(journalEntries()), gate = deferredHistory(), order = [];
  const downloads = downloadWindow();
  const document = { createElement: tag => new Element(tag), head: new Element('head'), body: new Element('body') };
  const popup = { ...downloads.window, document, closed: false, confirm: () => false };
  let blocked = false;
  const f = fixture({ createHistoryStore: () => backend.journal,
    window: { open: () => { order.push('open'); return blocked ? null : popup; }, setTimeout: () => 0 } });
  await settleHistoryWrites();
  backend.hooks.refresh = () => { order.push('refresh'); return gate.promise; };
  historyControl(f, 'Open log window').fire('click');
  assert.equal(order[0], 'open'); await settleHistoryWrites(); assert.deepEqual(order, ['open', 'refresh']);
  assert.match(popup.document.body.textContent, /Loading activity/);
  gate.resolve(); await settleHistoryWrites();
  blocked = true; historyControl(f, 'Open log window').fire('click');
  assert.match(f.container.textContent, /log window was blocked.*Activity log here/);
  assert.equal(historyControl(f, 'Download log').disabled, false); assert.deepEqual(f.messages, []);
  f.panel.dispose();
});

test('teardown disposes every bound journal and late initial completion cannot start Presence', async () => {
  const a = historyBackend(), b = historyBackend(), gate = deferredHistory(); let actor = 'a';
  a.hooks.refresh = () => gate.promise;
  const f = fixture({ createHistoryStore: key => key === 'key-a' ? a.journal : b.journal,
    inspectAccount: () => ({ accountVerified: true, usable: true, accountId: `owner_${actor}`, accountKey: `key-${actor}` }) });
  const pending = f.panel.begin(); actor = 'b'; f.panel.refreshLog();
  f.panel.dispose(); gate.resolve(); assert.equal(await pending, false);
  assert.equal(a.calls.disposed, 1); assert.equal(b.calls.disposed, 1); assert.equal(f.starts.length, 0);
  assert.equal(f.panel.busy(), false);
});

for (const drift of ['disposed', 'busy', 'account-key']) {
  test(`a pending Presence confirmation cannot start after ${drift} changes`, async () => {
    const backends = new Map(), gate = deferredHistory();
    let busy = false, key = 'original-key', reviewed;
    const f = fixture({ busy: () => busy,
      createHistoryStore: accountKey => {
        if (!backends.has(accountKey)) backends.set(accountKey, historyBackend());
        return backends.get(accountKey).journal;
      },
      inspectAccount: () => ({ accountVerified: true, usable: true, accountId: 'same_owner', accountKey: key }),
      confirm: ({ binding }) => { reviewed = binding; return gate.promise; } });
    await settleHistoryWrites(); const pending = f.panel.begin(); await settleHistoryWrites();
    assert.ok(reviewed);
    if (drift === 'disposed') f.panel.dispose();
    if (drift === 'busy') busy = true;
    if (drift === 'account-key') key = 'different-key';
    gate.resolve(reviewed); assert.equal(await pending, false); assert.equal(f.starts.length, 0);
    f.panel.dispose();
  });
}

test('journal mode performs no factory, storage, Clear or export work for an unknown account', async () => {
  let factories = 0, confirmations = 0;
  const f = fixture({ createHistoryStore: () => { factories += 1; return historyBackend().journal; },
    inspectAccount: () => ({ accountVerified: false, usable: false }),
    window: { confirm: () => { confirmations += 1; return true; } } });
  showHistory(f); historyControl(f, 'Download log').fire('click');
  await historyControl(f, 'Clear log').fire('click'); assert.equal(await f.panel.begin(), false);
  assert.equal(factories, 0); assert.equal(confirmations, 0); assert.equal(f.starts.length, 0); f.panel.dispose();
});

test('journal Saving and acknowledged Saved stay inside history while Presence completion remains intact', async () => {
  const backend = historyBackend(journalEntries()), gate = deferredHistory(); backend.hooks.append = () => gate.promise;
  const f = fixture({ createHistoryStore: () => backend.journal }); await settleHistoryWrites();
  assert.equal(await f.panel.begin(), true); await settleHistoryWrites();
  const completed = f.messages.at(-1); assert.match(completed, /Presence finished/);
  assert.match(f.container.textContent, /Saving activity/);
  assert.doesNotMatch(f.container.textContent, /Activity saved\./);
  gate.resolve(); await settleHistoryWrites();
  assert.match(f.container.textContent, /Activity saved\./); assert.equal(f.messages.at(-1), completed);
  f.panel.dispose();
});

test('blocked popup and Clear transports are contained without changing stored activity', async () => {
  const backend = historyBackend(journalEntries());
  const f = fixture({ createHistoryStore: () => backend.journal,
    window: { open() { throw new Error('browser popup policy'); }, confirm() { throw new Error('closed popup'); } } });
  await settleHistoryWrites();
  historyControl(f, 'Open log window').fire('click'); assert.match(f.container.textContent, /log window was blocked/);
  assert.equal(await historyControl(f, 'Clear log').fire('click'), false);
  assert.equal(backend.calls.clear, 0); assert.equal(backend.journal.snapshot().entries.length, 1);
  assert.deepEqual(f.messages, []); f.panel.dispose();
});

test('an unavailable journal factory cannot fall back to full-snapshot history or start actions', async () => {
  let reads = 0, writes = 0;
  const f = fixture({ createHistoryStore: () => null,
    readLog: () => { reads += 1; }, writeLog: () => { writes += 1; } });
  assert.equal(await f.panel.begin(), false);
  assert.equal(reads, 0); assert.equal(writes, 0); assert.equal(f.starts.length, 0);
  assert.equal(f.container.all().find(node => node.className === 'presence-log').open, true);
  assert.match(f.container.textContent, /could not be loaded.*retry/); f.panel.dispose();
});

test('late verified actor appends to all ninety stored history entries instead of replacing them', async () => {
  const f = scopedHistoryFixture();
  f.setActor('a');
  assert.equal(await f.panel.begin(), true);
  await settleHistoryWrites();
  const record = f.stores.get(f.actors.a.accountKey), ids = retainedHistoryIds(record.entries);
  assert.ok(f.original.a.entries.every(entry => ids.has(entry.eventId)), 'all ninety prior entries survive ordinary reviewed Start');
  assert.equal(record.entries.length, 92, 'the fixture adds only the started and completed session records');
  assert.deepEqual(f.stores.get(f.actors.b.accountKey), f.original.b);
  f.panel.dispose();
});

test('an idle actor switch cannot copy the prior actor history over the next actor history', async () => {
  const f = scopedHistoryFixture('a');
  f.setActor('b');
  assert.equal(await f.panel.begin(), true);
  await settleHistoryWrites();
  const record = f.stores.get(f.actors.b.accountKey), ids = retainedHistoryIds(record.entries);
  assert.ok(f.original.b.entries.every(entry => ids.has(entry.eventId)), 'the current actor keeps its own ninety entries');
  assert.ok(record.entries.every(entry => !entry.eventId.startsWith('a:retained:')), 'actor A cached history never enters actor B storage');
  assert.deepEqual(f.stores.get(f.actors.a.accountKey), f.original.a);
  f.panel.dispose();
});

test('a settling run from actor A cannot write its cached record into newly active actor B storage', async () => {
  const f = scopedHistoryFixture('a');
  let finish;
  f.session.start = () => new Promise(resolve => { finish = resolve; });
  const pending = f.panel.begin();
  await settleHistoryWrites();
  assert.equal(typeof finish, 'function');
  f.setActor('b');
  finish({ status: 'needs-attention', completed: 0, uncertain: 1, accountId: f.actors.a.accountId, results: [] });
  await pending; await settleHistoryWrites();
  assert.deepEqual(f.stores.get(f.actors.b.accountKey), f.original.b, 'a completed old-account write cannot target the new account key');
  const ids = retainedHistoryIds(f.stores.get(f.actors.a.accountKey).entries);
  assert.ok(f.original.a.entries.every(entry => ids.has(entry.eventId)));
  f.panel.dispose();
});

test('unknown account history performs no storage IO and late Activity log opening hydrates ninety entries without a run', async () => {
  const downloads = downloadWindow();
  let confirmations = 0;
  downloads.window.confirm = () => { confirmations += 1; return true; };
  const ready = [];
  const f = scopedHistoryFixture(null, { window: downloads.window, onAccountReady: account => ready.push(account.accountKey) });
  showHistory(f); f.panel.render();
  historyControl(f, 'Download log').fire('click'); historyControl(f, 'Clear log').fire('click');
  assert.equal(await f.panel.begin(), false);
  assert.deepEqual(f.reads, []); assert.deepEqual(f.writes, []); assert.equal(confirmations, 0); assert.equal(downloads.blobs.length, 0);
  f.setActor('a'); showHistory(f);
  assert.equal(historyControl(f, 'Download log').disabled, false);
  historyControl(f, 'Download log').fire('click');
  const exported = JSON.parse(await downloads.blobs[0].text());
  assert.equal(exported.entries.length, 90); assert.deepEqual(exported.entries.map(entry => entry.eventId), f.original.a.entries.map(entry => entry.eventId));
  assert.equal(f.starts.length, 0); assert.deepEqual(f.writes, []); assert.deepEqual(ready, [f.actors.a.accountKey]);
  f.setActor('b'); f.panel.render();
  historyControl(f, 'Download log').fire('click');
  const current = JSON.parse(await downloads.blobs[1].text());
  assert.ok(current.entries.every(entry => entry.eventId.startsWith('b:')));
  const recent = f.container.all().find(node => node.attributes.get('aria-label') === 'Recent Presence activity');
  assert.doesNotMatch(recent.textContent, /a Fixture/); assert.match(recent.textContent, /b Fixture/);
  f.panel.dispose();
});

test('queued and failed writes from actor A retain their captured scope after actor B becomes visible', async () => {
  for (const failed of [false, true]) {
    const f = scopedHistoryFixture('a');
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    f.hooks.write = async (value, key) => {
      await gate;
      if (failed) throw new Error('fixture-write-failed');
      f.stores.set(key, structuredClone(value));
    };
    await f.panel.begin();
    f.setActor('b'); f.panel.refreshLog();
    const messages = [...f.messages];
    release(); await settleHistoryWrites();
    assert.ok(f.writes.every(write => write.key === f.actors.a.accountKey));
    assert.deepEqual(f.stores.get(f.actors.b.accountKey), f.original.b);
    assert.deepEqual(f.messages, messages, 'an old account write failure cannot replace the current account status');
    if (failed) assert.deepEqual(f.stores.get(f.actors.a.accountKey), f.original.a);
    else assert.equal(f.stores.get(f.actors.a.accountKey).entries.length, 92);
    f.hooks.write = null;
    f.setActor('a'); await f.panel.begin(); await settleHistoryWrites();
    assert.equal(f.stores.get(f.actors.a.accountKey).entries.length, 94, 'in-memory unsaved records survive a write failure for their owner');
    assert.deepEqual(f.stores.get(f.actors.b.accountKey), f.original.b);
    f.panel.dispose();
  }
});

test('Clear is explicit, account-continuous, cancellable, and confined to the displayed owner', async () => {
  const confirmations = [];
  const f = scopedHistoryFixture('a', { window: { confirm: message => { confirmations.push(message); return false; } } });
  historyControl(f, 'Clear log').fire('click'); await settleHistoryWrites();
  assert.equal(confirmations.length, 1); assert.match(confirmations[0], /@fixture_owner_a/);
  assert.deepEqual(f.writes, []); assert.deepEqual(f.stores.get(f.actors.a.accountKey), f.original.a);
  f.window.confirm = () => { f.setActor('b'); return true; };
  historyControl(f, 'Clear log').fire('click'); await settleHistoryWrites();
  assert.deepEqual(f.writes, []); assert.deepEqual(f.stores.get(f.actors.b.accountKey), f.original.b);
  f.setActor('a'); f.panel.refreshLog(); f.window.confirm = () => true;
  historyControl(f, 'Clear log').fire('click'); await settleHistoryWrites();
  assert.equal(f.stores.get(f.actors.a.accountKey).entries.length, 0);
  assert.deepEqual(f.stores.get(f.actors.b.accountKey), f.original.b);
  assert.equal(historyControl(f, 'Download log').disabled, true);
  f.panel.dispose();
});

test('scoped hydration failure cannot replace stored history and normal retention remains bounded to five hundred', async () => {
  const failed = scopedHistoryFixture();
  failed.hooks.read = () => { throw new Error('fixture-read-failed'); };
  failed.setActor('a'); await failed.panel.begin(); await settleHistoryWrites();
  assert.deepEqual(failed.writes, []); assert.deepEqual(failed.stores.get(failed.actors.a.accountKey), failed.original.a);
  assert.equal(historyControl(failed, 'Download log').disabled, true); failed.panel.dispose();
  const bounded = scopedHistoryFixture('a', { size: 500 });
  await bounded.panel.begin(); await settleHistoryWrites();
  const record = bounded.stores.get(bounded.actors.a.accountKey);
  assert.equal(record.entries.length, 500);
  assert.ok(record.entries.some(entry => entry.outcome === 'started'));
  assert.ok(record.entries.some(entry => entry.outcome === 'completed' && entry.kind === 'session'));
  assert.ok(record.entries.every(entry => !entry.eventId.startsWith('b:')));
  assert.deepEqual(bounded.stores.get(bounded.actors.b.accountKey), bounded.original.b); bounded.panel.dispose();
});

test('Pause Resume Stop and late results remain on the reviewed actor after another actor becomes visible', async () => {
  const f = scopedHistoryFixture('a'); let finish;
  const base = { runId: 'fixture-run-a', accountId: f.actors.a.accountId, completed: 0, results: [] };
  f.session.start = () => new Promise(resolve => { finish = resolve; });
  const pending = f.panel.begin(); await settleHistoryWrites();
  f.render({ ...base, status: 'running', canPause: true, canStop: true });
  f.session.pause = () => { f.render({ ...base, status: 'paused', canResume: true, canStop: true }); return true; };
  f.session.resume = () => { f.render({ ...base, status: 'running', canPause: true, canStop: true }); return true; };
  f.session.stop = () => { f.render({ ...base, status: 'stopping' }); return true; };
  f.setActor('b'); f.panel.refreshLog();
  historyControl(f, 'Pause').fire('click'); historyControl(f, 'Resume').fire('click'); historyControl(f, 'Stop').fire('click');
  finish({ ...base, status: 'stopped', results: [{ eventId: 'fixture-a-late-result', at: 1_800_000_000_001,
    action: 'likePosts', label: 'Post fixture_a', status: 'completed', reason: 'Post liked' }] });
  await pending; await settleHistoryWrites();
  const record = f.stores.get(f.actors.a.accountKey);
  assert.ok(record.entries.some(entry => entry.outcome === 'paused'));
  assert.ok(record.entries.some(entry => entry.outcome === 'resumed'));
  assert.ok(record.entries.some(entry => entry.eventId === 'fixture-a-late-result'));
  assert.ok(f.writes.every(write => write.key === f.actors.a.accountKey));
  assert.deepEqual(f.stores.get(f.actors.b.accountKey), f.original.b);
  f.session.stop = () => false; f.panel.dispose();
});

test('stale popup export and Clear controls cannot operate on another account after a switch', async () => {
  const popupDownload = downloadWindow();
  const document = { createElement: tag => new Element(tag), head: new Element('head'), body: new Element('body') };
  let confirmations = 0;
  const popup = { ...popupDownload.window, document, closed: false, confirm: () => { confirmations += 1; return false; } };
  const f = scopedHistoryFixture('a', { window: { open: () => popup, setTimeout: () => 0 } });
  historyControl(f, 'Open log window').fire('click');
  const popupButton = label => document.body.all().find(node => node.tagName === 'button' && node.textContent === label);
  const oldDownload = popupButton('Download log'), oldClear = popupButton('Clear log');
  assert.match(document.body.textContent, /Stored only in this browser for @fixture_owner_a\./);
  f.setActor('b'); oldClear.fire('click'); oldDownload.fire('click');
  assert.equal(confirmations, 0); assert.equal(popupDownload.blobs.length, 0); assert.deepEqual(f.writes, []);
  assert.match(document.body.textContent, /Stored only in this browser for @fixture_owner_b\./); assert.doesNotMatch(document.body.textContent, /a Fixture/);
  popupButton('Download log').fire('click');
  const exported = JSON.parse(await popupDownload.blobs[0].text());
  assert.ok(exported.entries.every(entry => entry.eventId.startsWith('b:')));
  assert.deepEqual(f.stores.get(f.actors.a.accountKey), f.original.a);
  assert.deepEqual(f.stores.get(f.actors.b.accountKey), f.original.b); f.panel.dispose();
});

test('Live like me ignores a hidden invalid session count and preserves the last usable session preference', async () => {
  const f = fixture();
  f.attr('data-presence-limit').value = '';
  f.attr('data-presence-mode').value = 'live';
  assert.doesNotThrow(() => f.attr('data-presence-mode').fire('change'));
  assert.equal(await f.panel.begin(), true);
  assert.equal(f.starts.length, 1);
  assert.equal(f.starts[0].options.mode, 'live');
  assert.equal(f.starts[0].options.maxActions, null);
  assert.equal(f.preferences().sessionActions, 10);
});

test('an invalid One session count remains actionable without an unhandled change event', async () => {
  const f = fixture();
  f.attr('data-presence-limit').value = '';
  assert.doesNotThrow(() => f.attr('data-presence-limit').fire('change'));
  assert.equal(await f.panel.begin(), false);
  assert.equal(f.starts.length, 0);
  assert.match(f.messages.at(-1), /valid action limit/);
});

test('a confirmation transport failure restores Start and allows a fresh reviewed attempt', async () => {
  let attempts = 0;
  const f = fixture({ confirm: async ({ binding }) => {
    if (++attempts === 1) throw new Error('fixture-ui-unavailable');
    return binding;
  } });
  assert.equal(await f.panel.begin(), false);
  assert.equal(f.starts.length, 0);
  assert.equal(f.start().disabled, false);
  assert.match(f.messages.at(-1), /Nothing changed/);
  assert.equal(await f.panel.begin(), true);
  assert.equal(f.starts.length, 1);
});

test('Live like me explains its scope and the waiting status exposes retry and reviewed end time', () => {
  const f = fixture();
  f.attr('data-presence-mode').value = 'live';
  f.attr('data-presence-mode').fire('change');
  assert.match(f.attr('data-presence-mode-help').textContent, /does not learn your tastes/);
  assert.match(f.attr('data-presence-mode-help').textContent, /Keep this Instagram tab open/);
  f.render({ status: 'waiting', waitingReason: 'no-activities', completed: 4,
    skipped: 2, maxActions: null, nextActionAt: 1_800_000_002_000,
    expiresAt: 1_800_003_600_000, results: [], canStop: true });
  const status = f.container.all().find(node => node.attributes.get('role') === 'status');
  assert.equal(status.attributes.get('aria-live'), 'polite');
  assert.match(status.textContent, /Waiting for eligible activity/);
  assert.match(status.textContent, /4 verified actions\. 2 skipped/);
  assert.match(status.textContent, /Checking again at/);
  assert.match(status.textContent, /Run ends at/);
});

test('an exhausted session reports that its goal was not reached rather than presenting the limit as completed', () => {
  const f = fixture();
  f.render({ status: 'completed', reason: 'presence-no-activities', completed: 0,
    maxActions: 10, results: [] });
  const status = f.container.all().find(node => node.attributes.get('role') === 'status');
  assert.match(status.textContent, /No eligible activity found/);
  assert.match(status.textContent, /0 of 10 verified actions/);
  assert.doesNotMatch(status.textContent, /Presence finished/);
});

test('a saved short live duration and nonpreset break choices remain exactly reviewed instead of expanding', async () => {
  const confirmations = [];
  const f = fixture({ saved: { actions: { likePosts: true }, mode: 'live',
    liveDurationMinutes: 30, scheduledBreaks: true, liveBurstActions: 2, quietMinutes: 4 },
  confirm: async input => { confirmations.push(input); return input.binding; } });
  assert.equal(await f.panel.begin(), true);
  assert.equal(f.starts[0].options.liveDurationMinutes, 30);
  assert.equal(f.starts[0].options.liveBurstActions, 2);
  assert.equal(f.starts[0].options.quietMinutes, 4);
  assert.match(confirmations[0].message, /30 minutes/);
  assert.equal(confirmations[0].binding.expiresAt, 1_800_000_000_000 + 30 * 60_000);
});
