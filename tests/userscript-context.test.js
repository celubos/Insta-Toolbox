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
