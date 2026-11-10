import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../userscripts/src/toolbox-shell.js', import.meta.url), 'utf8');
const logic = source.slice(source.indexOf('  function currentContext()'), source.indexOf('  function renderContext()'));
function fixture({ view = 'checker', path = '/creator/', verified = false, session = {}, busy = false } = {}) {
  const context = vm.createContext({
    engine: { inspectSession: () => session, normalizeUsername: () => path === '/creator/' ? 'creator' : '' },
    presenceSession: null, presencePanel: { busy: () => busy },
    inspectPresenceAccount: () => ({ accountVerified: verified }),
    preferences: { view }, location: { pathname: path },
    openFollowerListContext: () => ({ label: 'Following' }),
  });
  vm.runInContext(logic, context);
  return context.currentContext();
}
test('each active tool explains its own next step instead of an unrelated open follower list', () => {
  assert.equal(fixture().title, 'Following list open');
  assert.equal(fixture({ view: 'account', verified: true }).title, 'Presence ready');
  assert.match(fixture({ view: 'account' }).title, /Verify/);
  assert.match(fixture({ view: 'messages' }).title, /Open a conversation/);
  assert.match(fixture({ view: 'messages' }).detail, /Ghost Mode.*separate review/);
});
test('DM context distinguishes the inbox from a conversation', () => {
  assert.equal(fixture({ view: 'messages', path: '/direct/inbox/' }).title, 'Inbox open');
  assert.equal(fixture({ view: 'messages', path: '/direct/t/123/' }).title, 'Conversation open');
});
test('restrictions take priority over tool readiness and active-session copy', () => {
  for (const [flag, title] of [['sessionExpired', 'Signed out'], ['challenge', 'Instagram wants a security check'],
    ['actionBlocked', 'Action blocked'], ['rateLimited', 'Rate limited']]) {
    assert.equal(fixture({ view: 'account', verified: true, busy: true, session: { [flag]: true } }).title, title);
  }
});

test('switching tools refreshes the contextual guidance without waiting for Instagram navigation', () => {
  const updates = [];
  const context = vm.createContext({
    preferences: { view: 'checker' }, normalizePreferences: value => value,
    PREFERENCES_KEY: 'preferences', GM_setValue: () => {}, applyLayout: () => {}, renderShellState: () => {},
    clearContextStatus: () => updates.push('clear'),
    renderContext: () => updates.push(context.preferences.view),
  });
  vm.runInContext(source.slice(source.indexOf('  function savePreferences('), source.indexOf('  function currentQueueItem(')), context);
  context.savePreferences({ view: 'account' });
  context.savePreferences({ view: 'messages' });
  assert.deepEqual(updates, ['clear', 'account', 'clear', 'messages']);
});

test('unchanged context text does not replace live-region content and repeat announcements', () => {
  let text = 'Presence active', replacements = 0;
  const node = { get textContent() { return text; }, set textContent(value) { text = value; replacements += 1; } };
  const context = vm.createContext({ query: () => node });
  vm.runInContext(source.slice(source.indexOf('  const setText ='), source.indexOf('  let contextStatus ='))
    + '\nglobalThis.updateText = setText;', context);
  context.updateText('context-title', 'Presence active');
  context.updateText('context-title', 'Presence paused');
  context.updateText('context-title', 'Presence paused');
  assert.equal(text, 'Presence paused');
  assert.equal(replacements, 1);
});

test('a new Presence run clears the previous result without discarding current-run error feedback', () => {
  const rendered = [];
  let notice = 'Presence finished. 2 of 2 verified actions.';
  const context = vm.createContext({ presenceContextRunId: null,
    presencePanel: { render: () => {} },
    clearContextStatus: () => { notice = null; },
    renderContext: () => rendered.push(notice),
  });
  vm.runInContext(source.slice(source.indexOf('  function onPresenceUpdate('), source.indexOf('  const dmRunner =')), context);
  context.onPresenceUpdate({ runId: 'next-run', status: 'running' });
  notice = 'Presence activity could not be saved.';
  context.onPresenceUpdate({ runId: 'next-run', status: 'waiting' });
  assert.deepEqual(rendered, [null, 'Presence activity could not be saved.']);
});

test('private history factory captures the actor key and uses modern manager storage without snapshot fallback', async () => {
  const start = source.indexOf('      createHistoryStore: accountKey =>');
  const end = source.indexOf('      onAccountReady:', start);
  assert.ok(start >= 0 && end > start);
  const stores = new Map([['instaToolboxPresenceActivityLogV1:fixture-a', { entries: ['a-history'] }],
    ['instaToolboxPresenceActivityLogV1:fixture-b', { entries: ['b-history'] }]]);
  const notices = new Map(), removed = [];
  const context = vm.createContext({ nativeActions: { inspectContext() { throw new Error('current viewer must not address delayed writes'); } },
    GM: { getValue: async (key, fallback) => structuredClone(stores.get(key) ?? fallback),
      setValue: async (key, value) => stores.set(key, structuredClone(value)),
      listValues: async () => [...stores.keys()], deleteValue: async key => stores.delete(key) },
    GM_getValue() { throw new Error('no legacy snapshot read fallback'); },
    GM_setValue() { throw new Error('no legacy snapshot write fallback'); },
    GM_addValueChangeListener: (key, callback) => { notices.set(1, { key, callback }); return 1; },
    GM_removeValueChangeListener: id => removed.push(id),
    InstaToolboxPresenceHistoryJournal: { create: options => options } });
  vm.runInContext(`globalThis.logAdapters = { ${source.slice(start, end)} };`, context);
  const adapter = context.logAdapters.createHistoryStore('fixture-a');
  assert.equal(adapter.accountKey, 'fixture-a');
  assert.deepEqual(await adapter.readLegacy(), { entries: ['a-history'] });
  await adapter.storage.setValue('synthetic-private-operation', { entries: ['a-late-result'] });
  assert.deepEqual(await adapter.storage.getValue('synthetic-private-operation'), { entries: ['a-late-result'] });
  assert.ok((await adapter.storage.listValues()).includes('synthetic-private-operation'));
  let delivered; const noticeId = adapter.storage.listen('private-notice', value => { delivered = value; });
  notices.get(noticeId).callback('private-notice', null, 'delivered'); assert.equal(delivered, 'delivered');
  adapter.storage.unlisten(noticeId); assert.deepEqual(removed, [noticeId]);
  await adapter.storage.deleteValue('synthetic-private-operation');
  assert.equal(stores.has('synthetic-private-operation'), false);
  assert.deepEqual(stores.get('instaToolboxPresenceActivityLogV1:fixture-a'), { entries: ['a-history'] });
  assert.deepEqual(stores.get('instaToolboxPresenceActivityLogV1:fixture-b'), { entries: ['b-history'] });
  assert.throws(() => context.logAdapters.createHistoryStore(), /account-unverified/);
  for (const name of ['getValue', 'setValue', 'listValues', 'deleteValue']) {
    const saved = context.GM[name]; delete context.GM[name];
    assert.throws(() => context.logAdapters.createHistoryStore('fixture-a'), /private-storage-unavailable/);
    context.GM[name] = saved;
  }
});

test('late verified history refreshes only stale idle Presence guidance and preserves existing progress and view', () => {
  const start = source.indexOf('      onAccountReady: () => {');
  const end = source.indexOf('\n      busy:', start);
  assert.ok(start >= 0 && end > start);
  const fields = { context: { dataset: {} }, 'context-title': { textContent: 'Verify your signed-in account' },
    'context-detail': { textContent: 'retained workflow message' }, 'context-cta': { dataset: {} } };
  const notice = { message: 'retained workflow message', tone: 'warning' };
  const context = vm.createContext({ preferences: { view: 'account' }, contextStatus: notice,
    engine: { inspectSession: () => ({}) }, presenceSession: null,
    presencePanel: { busy: () => false }, presenceGrowthPanel: null, inboxPanel: null,
    relationshipController: null, manualScanController: null, dmCleanupController: null, accountActionController: null,
    dmRunner: { snapshot: () => ({ status: 'idle', canStop: false }) }, state: { run: { status: 'idle' } },
    inspectPresenceAccount: () => ({ accountVerified: true }),
    query: selector => fields[selector.match(/data-role="([^"]+)"/)?.[1]],
    setText: (role, value) => { fields[role].textContent = value; } });
  const renderer = source.slice(source.indexOf('  function renderContext()'), source.indexOf('  // --- Section 3:'));
  const callback = source.slice(start + '      onAccountReady: '.length, end).trim().replace(/,$/, '');
  vm.runInContext(`${logic}\n${renderer}\nglobalThis.notifyAccountReady = ${callback};`, context);
  context.notifyAccountReady();
  assert.equal(fields['context-title'].textContent, 'Presence ready');
  assert.equal(fields['context-detail'].textContent, notice.message); assert.equal(context.contextStatus, notice);
  assert.equal(context.preferences.view, 'account');
  fields['context-title'].textContent = 'Verify your signed-in account';
  context.relationshipController = {};
  context.notifyAccountReady(); assert.equal(fields['context-title'].textContent, 'Verify your signed-in account');
  context.relationshipController = null;
  context.dmRunner = { snapshot: () => ({ status: 'preparing', canStop: false }) };
  context.notifyAccountReady(); assert.equal(fields['context-title'].textContent, 'Verify your signed-in account');
  context.dmRunner = null; context.preferences.view = 'messages';
  context.notifyAccountReady(); assert.equal(fields['context-title'].textContent, 'Verify your signed-in account');
  assert.equal(context.preferences.view, 'messages'); assert.equal(fields['context-detail'].textContent, notice.message);
});
