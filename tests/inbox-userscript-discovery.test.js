import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createUserscriptInboxDiscovery } from '../extension/inbox-userscript-discovery.js';

const viewerSource = await readFile(new URL('../extension/instagram-viewer.js', import.meta.url), 'utf8');
const viewerContext = vm.createContext({ URL }); vm.runInContext(viewerSource, viewerContext);
const accountKey = viewerContext.InstaToolboxInstagramViewer.accountKey;

function fixture({ noRoute = false, onNavigate = null, unsupportedSection = false, messagesRoute = false,
  checkpointStorage = null, now = Date.now, threadIds = ['12345'], withLabels = false } = {}) {
  let url = new URL('https://www.instagram.com/direct/inbox/'), account = 'fixture.owner', clicks = 0, pane = null, header = null;
  const listeners = new Map();
  const window = { get location() { return url; }, getComputedStyle: () => ({ overflowY: 'visible' }),
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: (name, callback) => { if (listeners.get(name) === callback) listeners.delete(name); } };
  const node = (extra) => ({ isConnected: true, getClientRects: () => [{}], closest: () => null, ...extra });
  const replacePane = (mounted) => {
    if (pane) pane.isConnected = false;
    if (header) header.isConnected = false;
    const actions = [node({})];
    pane = mounted ? node({ getAttribute: () => null, contains: (target) => actions.includes(target),
      querySelectorAll: (selector) => selector === '[aria-label="Message actions"]' ? actions : [] }) : null;
    header = null;
    if (pane && withLabels) {
      const heading = node({ textContent: `Observed chat ${url.pathname.split('/')[3]}` });
      header = node({ getAttribute: name => name === 'data-pagelet' ? 'IGDInboxHeaderOffMsys' : null,
        querySelectorAll: selector => selector === 'h2' ? [heading] : [] });
      const content = node({ contains: target => target === pane,
        getAttribute: () => null, querySelectorAll: selector => selector === '[data-pagelet="IGDComposerForCannes"]' ? [node({})] : [] });
      const parent = node({ children: [header, content], querySelectorAll: selector => selector === '[data-pagelet="IGDMessagesList"]' ? [pane] : [] });
      pane.parentElement = content; content.parentElement = parent;
    }
  };
  const section = node({ textContent: 'Primary', getAttribute: (name) => name === 'aria-selected' ? 'true' : null });
  const rows = threadIds.map((threadId, index) => node({ tagName: 'DIV', inRoot: true, parentElement: { closest: () => null },
    textContent: `Synthetic conversation preview${index ? ` ${index}` : ''}`,
    getAttribute: () => null, querySelector: () => ({}), click() {
      clicks += 1; if (!noRoute) { url = new URL(`https://www.instagram.com/direct/t/${threadId}/`); replacePane(true); } onNavigate?.(api, threadId);
    } }));
  const root = node({ clientHeight: 100, scrollHeight: 100, scrollTop: 0,
    contains: (element) => element.inRoot === true,
    querySelectorAll: (selector) => selector === '*' ? []
      : ['[role="tab"]', '[role="tab"][aria-selected="true"]'].includes(selector) ? unsupportedSection ? [] : [section] : rows });
  const back = node({ getAttribute: () => '/direct/inbox/', click: () => { url = new URL('https://www.instagram.com/direct/inbox/'); replacePane(false); } });
  const messages = node({ getAttribute: name => name === 'href' ? '/direct/t/999/' : null,
    querySelector: selector => selector === '[aria-label="Messages"]' ? {} : null,
    click: () => { url = new URL('https://www.instagram.com/direct/t/999/'); replacePane(true); } });
  const document = { documentElement: {}, querySelectorAll: (selector) => selector === '[aria-label="Thread list"]' ? [root]
    : selector === '[role="tab"]' ? unsupportedSection ? [] : [section] : selector === 'a[href]' ? messagesRoute ? [messages] : [back]
      : selector === '[data-pagelet="IGDMessagesList"]' ? pane ? [pane] : []
        : selector === '[data-pagelet="IGDInboxHeaderOffMsys"]' ? header ? [header] : [] : [],
    addEventListener: window.addEventListener, removeEventListener: window.removeEventListener };
  const viewer = { accountKey, inspect: () => ({ accountId: account, accountVerified: true,
    accountKey: accountKey(account), identityKind: 'verified-viewer-username', restriction: false }) };
  const progress = [];
  const adapter = createUserscriptInboxDiscovery({ document, window, viewer, routeTimeoutMs: 75,
    settleMs: 1, onProgress: (value) => progress.push(value), checkpointStorage, now });
  const api = { adapter, viewer, progress, listeners, row: rows[0], get clicks() { return clicks; },
    route: (value) => { url = new URL(value, 'https://www.instagram.com'); },
    rename: () => { account = 'another.owner'; }, fire: (name) => listeners.get(name)?.() };
  return api;
}

test('native same-tab discovery feeds a frozen selected-ID review without execution', async () => {
  const f = fixture();
  assert.deepEqual(f.adapter.availableSections(), ['primary']);
  const result = await f.adapter.discover({ navigationAcknowledged: true });
  assert.equal(result.status, 'ready'); assert.equal(result.executionAvailable, false);
  assert.equal(result.inventory.complete, false);
  assert.equal(result.inventory.conversations[0].threadId, '12345');
  assert.equal(result.inventory.accountId, accountKey('fixture.owner'));
  const review = f.adapter.review({ threadIds: ['12345'] });
  assert.equal(Object.isFrozen(review), true); assert.equal(Object.isFrozen(review.threadIds), true);
  assert.equal(review.discovery.complete, false); assert.equal(review.workerCount, 1);
  assert.equal(review.speed, 'standard'); assert.equal(review.removeOwnReactions, false);
  assert.deepEqual(review.threadIds, ['12345']);
  assert.ok(f.progress.some((state) => state.inventory?.conversations.length === 1));
  assert.equal(f.listeners.size, 0);
  assert.equal(Object.hasOwn(f.adapter, 'start'), false);
  result.inventory.conversations.length = 0;
  assert.equal(f.adapter.snapshot().inventory.conversations.length, 1);
});

test('discovery requires read-receipt acknowledgment before navigation', async () => {
  const f = fixture();
  await assert.rejects(f.adapter.discover(), /acknowledgment/);
  assert.equal(f.clicks, 0);
});

test('a personal inbox without section tabs can discover its primary conversations', async () => {
  const f = fixture({ unsupportedSection: true });
  const result = await f.adapter.discover({ navigationAcknowledged: true });
  assert.equal(result.status, 'ready');
  assert.equal(result.inventory.conversations[0].threadId, '12345'); assert.equal(f.clicks, 1);
});

test('Find can enter the inbox through an observed native link from another Instagram route', async () => {
  const f = fixture(); f.route('/fixture.owner/');
  const result = await f.adapter.discover({ navigationAcknowledged: true });
  assert.equal(result.status, 'ready');
  assert.equal(result.inventory.conversations[0].threadId, '12345');
});

test('Messages may open the last thread with its inbox rail instead of an inbox-only route', async () => {
  const f = fixture({ messagesRoute: true }); f.route('/');
  const result = await f.adapter.discover({ navigationAcknowledged: true });
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.inventory.conversations.map(row => row.threadId), ['12345']);
});

test('review cannot introduce an undiscovered thread or survive an account rename', async () => {
  const f = fixture(); await f.adapter.discover({ navigationAcknowledged: true });
  assert.throws(() => f.adapter.review({ threadIds: ['99999'] }), /not-discovered/);
  f.rename(); assert.throws(() => f.adapter.review({ threadIds: ['12345'] }), /account-changed/);
  assert.equal(f.adapter.snapshot().inventory, null);
});

test('account drift during navigation clears collected inventory and stops further clicks', async () => {
  const f = fixture({ onNavigate: (api) => api.rename() });
  await assert.rejects(f.adapter.discover({ navigationAcknowledged: true }), /account-changed/);
  assert.equal(f.clicks, 1); assert.equal(f.adapter.snapshot().inventory, null);
  assert.equal(f.listeners.size, 0);
});

test('concurrent discovery and review are rejected; Stop cancels pending navigation', async () => {
  const f = fixture({ noRoute: true });
  const pending = f.adapter.discover({ navigationAcknowledged: true });
  await assert.rejects(f.adapter.discover({ navigationAcknowledged: true }), /active/);
  assert.throws(() => f.adapter.review({ threadIds: ['12345'] }), /active/);
  assert.equal(f.adapter.stop(), true);
  const result = await pending;
  assert.equal(result.inventory.stopped, true); assert.equal(result.inventory.complete, false);
  assert.equal(f.adapter.stop(), false); assert.equal(f.listeners.size, 0);
});

test('freeze and pagehide revoke discovery without automatic return navigation', async () => {
  for (const event of ['freeze', 'pagehide']) {
    const f = fixture({ onNavigate: (api) => api.fire(event) });
    const result = await f.adapter.discover({ navigationAcknowledged: true });
    assert.equal(result.inventory.stopped, true, event);
    assert.equal(result.inventory.needsInboxReturn, false, event);
    assert.equal(f.clicks, 1, event); assert.equal(f.listeners.size, 0, event);
  }
});

test('copied or mismatched viewer metadata cannot stand in for verified native account proof', async () => {
  for (const field of ['accountVerified', 'accountKey', 'identityKind', 'restriction']) {
    const f = fixture(), original = f.viewer.inspect;
    f.viewer.inspect = () => ({ ...original(), [field]: field === 'restriction' ? true : false });
    await assert.rejects(f.adapter.discover({ navigationAcknowledged: true }), /viewer-unverified|account-restricted/);
    assert.equal(f.clicks, 0, field);
  }
});

test('wrapper exposes captured same-tab navigation separately from cleanup approval', async () => {
  const f = fixture();
  assert.throws(() => f.adapter.createNavigator({ expiresAt: Date.now() + 1_000 }), /discovery-required/);
  await f.adapter.discover({ navigationAcknowledged: true });
  assert.throws(() => f.adapter.createNavigator(), /navigation-expired/);
  const navigator = f.adapter.createNavigator({ expiresAt: Date.now() + 10_000 });
  const before = f.clicks;
  const result = await navigator.navigate('12345');
  assert.deepEqual(result, { accountId: accountKey('fixture.owner'), threadId: '12345', verified: true });
  assert.equal(f.clicks, before + 1);
  await navigator.navigate('12345');
  assert.equal(f.clicks, before + 1, 'already-current route does not click again');
  assert.equal(f.adapter.snapshot().executionAvailable, false);
  assert.deepEqual(Object.keys(navigator), ['stop', 'navigate']);
  assert.equal(f.adapter.stop(), true); assert.equal(f.listeners.size, 0);
});

test('changed captured row produces needs-attention without disclosing private matching text', async () => {
  const f = fixture(); await f.adapter.discover({ navigationAcknowledged: true });
  const navigator = f.adapter.createNavigator({ expiresAt: Date.now() + 10_000 });
  const before = f.clicks;
  f.row.textContent = 'Changed private preview';
  await assert.rejects(navigator.navigate('12345'), /conversation-row-changed/);
  assert.equal(f.clicks, before);
  const state = f.adapter.snapshot();
  assert.equal(state.status, 'needs-attention');
  assert.equal(JSON.stringify({ state, progress: f.progress }).includes('private preview'), false);
  assert.equal(f.listeners.size, 0);
});

test('account drift after navigator creation clears inventory and prevents navigation', async () => {
  const f = fixture(); await f.adapter.discover({ navigationAcknowledged: true });
  const navigator = f.adapter.createNavigator({ expiresAt: Date.now() + 10_000 });
  const before = f.clicks; f.rename();
  await assert.rejects(navigator.navigate('12345'), /account-changed/);
  assert.equal(f.clicks, before); assert.equal(f.adapter.snapshot().inventory, null);
  assert.equal(f.listeners.size, 0);
  assert.throws(() => f.adapter.createNavigator({ expiresAt: Date.now() + 10_000 }), /discovery-required/);
});

test('wrapper navigator is revoked by lifecycle interruption or pre-aborted signal', async () => {
  for (const event of ['freeze', 'pagehide', 'abort']) {
    const f = fixture(); await f.adapter.discover({ navigationAcknowledged: true });
    const navigator = f.adapter.createNavigator({ expiresAt: Date.now() + 10_000 });
    const before = f.clicks, controller = new AbortController();
    if (event === 'abort') controller.abort(); else f.fire(event);
    await assert.rejects(navigator.navigate('12345', { signal: controller.signal }), /page-interrupted|cancelled/);
    assert.equal(f.clicks, before, event); assert.equal(f.listeners.size, 0, event);
  }
});

test('a failed review revokes an existing navigator instead of letting restored metadata revive it', async () => {
  const f = fixture(); await f.adapter.discover({ navigationAcknowledged: true });
  const navigator = f.adapter.createNavigator({ expiresAt: Date.now() + 10_000 });
  const original = f.viewer.inspect;
  f.viewer.inspect = () => ({ ...original(), restriction: true });
  assert.throws(() => f.adapter.review({ threadIds: ['12345'] }), /account-restricted/);
  f.viewer.inspect = original;
  const before = f.clicks;
  await assert.rejects(navigator.navigate('12345'), /cancelled/);
  assert.equal(f.clicks, before); assert.equal(f.adapter.snapshot().inventory, null);
  assert.equal(f.listeners.size, 0);
});

function checkpointMemory(initial = null) {
  let value = structuredClone(initial);
  const writes = [];
  return { read: () => structuredClone(value), write(next) {
    value = structuredClone(next); writes.push(structuredClone(next));
  }, writes, get value() { return structuredClone(value); } };
}

function recoveryRecord(at = Date.now()) {
  return {
    version: 1, kind: 'insta-toolbox-inbox-discovery', accountId: accountKey('fixture.owner'),
    startedAt: at - 1_000, expiresAt: at + 10_000, savedAt: at - 500,
    sections: [{ section: 'primary', samples: 1 }],
    conversations: [{ threadId: '12345', sections: ['primary'] }],
    labels: [{ threadId: '12345', title: 'Historical chat', username: 'historical.person' }],
  };
}

test('a replacement document restores only checkpoint observations without navigation or native authority', async () => {
  const storage = checkpointMemory();
  const before = fixture({ checkpointStorage: storage, threadIds: ['12345', '67890'], withLabels: true,
    onNavigate: (api, id) => { if (id === '67890') api.fire('pagehide'); } });
  await before.adapter.discover({ navigationAcknowledged: true });
  assert.equal(before.clicks, 2);
  assert.deepEqual(storage.writes[0], null, 'a fresh discovery first clears old observations');
  assert.deepEqual(storage.value.conversations.map(row => row.threadId), ['12345']);
  assert.deepEqual(storage.value.labels, [{ threadId: '12345', title: 'Observed chat 12345', username: null }],
    'pagehide does not replace the last saved label with cleared in-memory labels');
  assert.equal(storage.value.kind, 'insta-toolbox-inbox-discovery');
  const after = fixture({ checkpointStorage: storage });
  assert.equal(await after.adapter.hasReadOnlyCheckpoint(), true);
  assert.equal(after.adapter.snapshot().inventory, null, 'presence probing reveals no inventory');
  const result = await after.adapter.restoreReadOnly();
  assert.equal(result.recovered, true);
  assert.equal(result.recoveryExpiresAt, storage.value.expiresAt);
  assert.equal(result.inventory.complete, false);
  assert.equal(result.executionAvailable, false);
  assert.deepEqual(result.inventory.conversations.map(row => row.threadId), ['12345']);
  assert.equal(after.adapter.reviewLabels()[0].source, 'recovered-observation');
  assert.equal(after.clicks, 0);
  assert.throws(() => after.adapter.createNavigator({ expiresAt: Date.now() + 1_000 }), /discovery-required/);
  assert.equal(after.adapter.validateReview(after.adapter.review({ threadIds: ['12345'] })), true);
});

test('recovered labels are sanitized historical display and stored authority fields are ignored', async () => {
  const record = recoveryRecord();
  record.labels[0].title = '  Historical\n  chat  ';
  record.labels[0].username = 'Historical.Person';
  Object.assign(record, { approval: 'forged', token: 'forged', selected: ['12345'], captured: {}, complete: true });
  Object.assign(record.labels[0], { source: 'native-conversation-header', verified: true });
  const storage = checkpointMemory(record), f = fixture({ checkpointStorage: storage });
  await f.adapter.restoreReadOnly();
  assert.deepEqual(f.adapter.reviewLabels(), [{ threadId: '12345', title: 'Historical chat',
    username: 'historical.person', kind: 'profile', source: 'recovered-observation' }]);
  const snapshot = f.adapter.snapshot();
  assert.equal(snapshot.inventory.complete, false);
  assert.equal(snapshot.executionAvailable, false);
  for (const key of ['approval', 'token', 'selected', 'captured']) assert.equal(Object.hasOwn(snapshot, key), false);
  assert.equal(f.clicks, 0);
});

test('checkpoint restoration verifies the same native account before and after storage awaits', async () => {
  let finishRead;
  const record = recoveryRecord();
  const f = fixture({ checkpointStorage: { read: () => new Promise(resolve => { finishRead = resolve; }), write() {} } });
  const pending = f.adapter.restoreReadOnly();
  f.rename(); finishRead(record);
  await assert.rejects(pending, /account-changed/);
  assert.equal(f.adapter.snapshot().inventory, null); assert.equal(f.clicks, 0);
  const other = fixture({ checkpointStorage: checkpointMemory({ ...record, accountId: accountKey('another.owner') }) });
  assert.equal(await other.adapter.hasReadOnlyCheckpoint(), true, 'presence probing is account-neutral');
  await assert.rejects(other.adapter.restoreReadOnly(), /account-changed/);
  const unverified = fixture({ checkpointStorage: checkpointMemory(record) });
  const original = unverified.viewer.inspect;
  unverified.viewer.inspect = () => ({ ...original(), accountVerified: false });
  await assert.rejects(unverified.adapter.restoreReadOnly(), /viewer-unverified/);
});

test('recovery never renews its original deadline and post-confirmation validation rejects drift', async () => {
  let at = Date.now(); const record = recoveryRecord(at), storage = checkpointMemory(record);
  const f = fixture({ checkpointStorage: storage, now: () => at });
  await f.adapter.restoreReadOnly();
  const review = f.adapter.review({ threadIds: ['12345'] });
  assert.equal(review.expiresAt, record.expiresAt, 'recovered review metadata retains the original deadline');
  assert.equal(f.adapter.validateReview(review), true);
  assert.throws(() => f.adapter.validateReview({ ...review, threadIds: ['99999'] }), /not-discovered/);
  assert.throws(() => f.adapter.validateReview({ ...review, accountId: accountKey('another.owner') }), /review-changed/);
  at = record.expiresAt;
  assert.throws(() => f.adapter.review({ threadIds: ['12345'] }), /recovery-expired/);
  assert.throws(() => f.adapter.validateReview(review), /recovery-expired/);
  assert.equal(await f.adapter.hasReadOnlyCheckpoint(), false);
  await assert.rejects(f.adapter.restoreReadOnly(), /expired/);
  assert.equal(storage.value.expiresAt, record.expiresAt);
  assert.equal(storage.writes.length, 0, 'restoration does not rewrite or extend observations');
  const changed = fixture({ checkpointStorage: checkpointMemory(recoveryRecord()) });
  await changed.adapter.restoreReadOnly(); const prior = changed.adapter.review({ threadIds: ['12345'] });
  changed.rename(); assert.throws(() => changed.adapter.validateReview(prior), /account-changed/);
});

test('malformed, excessive and expired checkpoints cannot restore target proposals', async () => {
  const at = Date.now();
  const mutations = [
    record => { record.kind = 'another-kind'; },
    record => { record.version = 2; },
    record => { record.startedAt = record.expiresAt; },
    record => { record.expiresAt = record.startedAt + 20 * 60_000 + 1; },
    record => { record.savedAt = at + 1; },
    record => { record.expiresAt = at; },
    record => { record.sections[0].section = 'unknown'; },
    record => { record.sections[0].samples = 1_001; },
    record => { record.conversations[0].threadId = 'not-a-thread'; },
    record => { record.conversations[0].sections = ['requests']; },
    record => { record.conversations.push(record.conversations[0]); },
    record => { record.conversations = Array.from({ length: 1_001 }, (_, i) => ({ threadId: String(i), sections: ['primary'] })); },
    record => { record.labels[0].threadId = '99999'; },
    record => { record.labels[0].title = 'Misleading\u202e title'; },
    record => { record.labels[0].title = 'x'.repeat(161); },
    record => { record.labels[0].username = 'not/a/profile'; },
  ];
  for (const mutate of mutations) {
    const record = recoveryRecord(at); mutate(record);
    const f = fixture({ checkpointStorage: checkpointMemory(record), now: () => at });
    assert.equal(await f.adapter.hasReadOnlyCheckpoint(), false);
    await assert.rejects(f.adapter.restoreReadOnly(), /checkpoint|expired/);
    assert.equal(f.clicks, 0); assert.equal(f.adapter.snapshot().inventory, null);
  }
});

test('storage failures stop discovery before subsequent navigation and never replace saved labels after Stop', async () => {
  let writes = 0;
  const failRead = fixture({ checkpointStorage: { read() { throw new Error('unavailable'); }, write() {} } });
  assert.equal(await failRead.adapter.hasReadOnlyCheckpoint(), false);
  await assert.rejects(failRead.adapter.restoreReadOnly(), /checkpoint-unavailable/);
  assert.equal(failRead.clicks, 0); assert.equal(failRead.adapter.snapshot().inventory, null);
  const failClear = fixture({ checkpointStorage: { read: () => null, write: () => { throw new Error('unavailable'); } } });
  await assert.rejects(failClear.adapter.discover({ navigationAcknowledged: true }), /checkpoint-unavailable/);
  assert.equal(failClear.clicks, 0);
  const failSave = fixture({ threadIds: ['12345', '67890'], checkpointStorage: { read: () => null, write: () => {
    writes += 1; if (writes > 1) throw new Error('unavailable');
  } } });
  const result = await failSave.adapter.discover({ navigationAcknowledged: true });
  assert.equal(result.inventory.stopped, true);
  assert.equal(result.reason, 'inbox-discovery-save-failed');
  assert.equal(failSave.clicks, 1);
  const record = recoveryRecord(), storage = checkpointMemory(record), f = fixture({ checkpointStorage: storage });
  await f.adapter.restoreReadOnly(); f.adapter.stop();
  assert.deepEqual(storage.value.labels, record.labels);
});

test('Stop during checkpoint reads and writes prevents later navigation or restoration', async () => {
  let finishRead;
  const read = fixture({ checkpointStorage: { read: () => new Promise(resolve => { finishRead = resolve; }), write() {} } });
  const restoring = read.adapter.restoreReadOnly(); assert.equal(read.adapter.stop(), true);
  finishRead(recoveryRecord()); await assert.rejects(restoring, /cancelled/);
  assert.equal(read.adapter.snapshot().inventory, null); assert.equal(read.clicks, 0);
  let finishWrite;
  const writing = fixture({ checkpointStorage: { read: () => null, write: () => new Promise(resolve => { finishWrite = resolve; }) } });
  const discovering = writing.adapter.discover({ navigationAcknowledged: true });
  assert.equal(writing.adapter.stop(), true); finishWrite();
  await assert.rejects(discovering, /cancelled/); assert.equal(writing.clicks, 0);
});

test('a new discovery invalidates an older pending restore without a late inventory overwrite', async () => {
  let finishRead;
  const storage = { read: () => new Promise(resolve => { finishRead = resolve; }), write() {} };
  const f = fixture({ checkpointStorage: storage });
  const restoring = f.adapter.restoreReadOnly();
  const found = await f.adapter.discover({ navigationAcknowledged: true, targetThreadId: '12345' });
  assert.equal(found.recovered, false);
  const old = recoveryRecord(); old.conversations[0].threadId = '99999'; old.labels[0].threadId = '99999';
  finishRead(old); await assert.rejects(restoring, /cancelled/);
  assert.equal(f.adapter.snapshot().recovered, false);
  assert.deepEqual(f.adapter.snapshot().inventory.conversations.map(row => row.threadId), ['12345']);
  assert.equal(f.clicks, 1);
});

test('a checkpoint expiring during its read cannot publish restored proposals', async () => {
  let at = Date.now(), finishRead;
  const record = recoveryRecord(at);
  const f = fixture({ now: () => at, checkpointStorage: {
    read: () => new Promise(resolve => { finishRead = resolve; }), write() {},
  } });
  const restoring = f.adapter.restoreReadOnly();
  at = record.expiresAt; finishRead(record);
  await assert.rejects(restoring, /recovery-expired/);
  assert.equal(f.adapter.snapshot().inventory, null); assert.equal(f.clicks, 0);
});

test('Stop while a proven-row checkpoint is saving prevents the next native click', async () => {
  let finishWrite, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  let saved;
  const storage = { read: () => saved, write(value) {
    if (value === null) { saved = null; return; }
    return new Promise(resolve => { finishWrite = () => { saved = structuredClone(value); resolve(); }; entered(); });
  } };
  const f = fixture({ checkpointStorage: storage, threadIds: ['12345', '67890'], withLabels: true });
  const discovering = f.adapter.discover({ navigationAcknowledged: true });
  await waiting; assert.equal(f.adapter.stop(), true); finishWrite();
  const result = await discovering;
  assert.equal(result.inventory.stopped, true); assert.equal(f.clicks, 1);
  assert.deepEqual(saved.labels, [{ threadId: '12345', title: 'Observed chat 12345', username: null }]);
});
