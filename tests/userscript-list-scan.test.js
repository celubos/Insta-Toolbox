import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../userscripts/src/toolbox-shell.js', import.meta.url), 'utf8');
const functionSource = name => {
  const match = source.match(new RegExp(`  (?:async )?function ${name}\\([\\s\\S]*?\\n  \\}`));
  assert.ok(match, name); return match[0];
};
function actionSource(name, next, { quoted = true } = {}) {
  const marker = `\n    ${quoted ? `'${name}'` : name}: `;
  const start = source.indexOf(marker);
  const end = source.indexOf(`\n    '${next}':`, start);
  assert.ok(start >= 0 && end > start, name);
  return `actions[${JSON.stringify(name)}] = ${source.slice(start + marker.length, end).trim().replace(/,$/, '')};`;
}
const freshCapture = () => ({ subjectUsername: 'fixture.owner', followers: [{ username: 'previous.row' }],
  following: [], complete: { followers: true }, verified: { followers: true },
  source: { followers: 'list-dialog' }, capturedAt: {} });

function fixture() {
  let resolve, reject, request;
  const gate = new Promise((done, fail) => { resolve = done; reject = fail; });
  const messages = [], saved = [], details = [];
  const fields = {
    'list-type': { value: 'following' }, 'scan-progress': { hidden: true },
    'scan-fill': { style: {} },
    'scan-bar': { dataset: {}, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; },
      removeAttribute(name) { delete this.attributes[name]; } },
    'list-scan-stop': { hidden: true, disabled: false, textContent: '' },
    'scan-detail': { tabIndex: 0, getClientRects: () => [{}], closest: () => null,
      focus(options) { this.focusOptions = options; context.shadow.activeElement = this; } },
    'checker-run': { disabled: false },
  };
  const scanButtons = new Map(['scan-following', 'scan-followers', 'scan-list', 'capture', 'clear-capture']
    .map(name => [name, { disabled: false }]));
  const state = { capture: freshCapture(), run: { status: 'idle', queue: ['untouched.target'] } };
  const context = vm.createContext({ AbortController, state, actions: {},
    manualScanController: null, relationshipController: null, relationshipProgress: null,
    inboxPanel: null, presencePanel: null, presenceGrowthPanel: null, dmCleanupController: null, accountActionController: null,
    dmRunner: { snapshot: () => ({ canStop: false }) },
    location: { pathname: '/fixture.owner/' }, preferences: { view: 'checker', open: true },
    engine: { normalizeUsername: value => String(value || '').replace(/^\/+|\/+$/g, '').toLowerCase(),
      collectAccountList(options) { request = options; return gate; } },
    query: selector => fields[selector.match(/data-role="([^"]+)"/)?.[1]] || null,
    shadow: { querySelectorAll: selector => [scanButtons.get(selector.match(/data-action="([^"]+)"/)?.[1])].filter(Boolean) },
    normalizeAccounts: rows => rows,
    verifiedCapture: type => state.capture.verified?.[type] ? state.capture[type] : [],
    stateDefaults: () => ({ capture: freshCapture() }),
    invalidatePresence() {}, nowIso: () => '2026-01-01T00:00:00Z',
    saveState: () => saved.push(JSON.parse(JSON.stringify(state.capture))),
    status: message => messages.push(message),
    safeText: (value, fallback = '') => String(value ?? '').trim() || fallback,
    formatCount: value => String(Number(value || 0)),
    setText(role, value) { if (role === 'scan-detail') details.push(value); },
    renderAll() { context.renderListScanControls(); },
  });
  for (const name of ['renderListScanControls', 'assertManualScanAvailable', 'resetRelationshipProgress',
    'scanProgressPercent', 'showScanProgress', 'settleFailedRelationshipProgress', 'scanInto',
    'sessionStop', 'currentProfileCaptureSubject', 'prepareCaptureWorkspace', 'reconciledRelationshipAccounts',
    'checkAccountRelationships', 'scanSentConversation', 'runDmUnsend', 'runReactionsOnly', 'startAccountRun']) {
    vm.runInContext(functionSource(name), context);
  }
  vm.runInContext(actionSource('scan-list', 'scan-sent')
    + actionSource('stop-list-scan', 'context-cta')
    + actionSource('capture', 'clear-capture', { quoted: false })
    + actionSource('clear-capture', 'show-more-comparison'), context);
  return { context, state, fields, scanButtons, messages, saved, details,
    request: () => request, resolve, reject,
    scan: type => context.scanInto(type),
    stop: () => context.actions['stop-list-scan'](),
    result(overrides = {}) { return { accounts: [{ username: 'new.one' }, { username: 'new.two' }],
      complete: false, expectedCount: 20, observedCount: 2, listType: 'followers',
      profilePath: '/fixture.owner/', reason: 'list-truncated', ...overrides }; },
  };
}

test('an active manual scan reports live counts and has a dedicated Stop that preserves partial rows', async () => {
  const f = fixture();
  const pending = f.scan('followers');
  const controller = f.context.manualScanController;
  assert.ok(controller);
  assert.equal(f.fields['list-type'].value, 'followers');
  assert.equal(f.fields['list-scan-stop'].hidden, false);
  assert.equal(f.fields['list-scan-stop'].textContent, 'Stop scan');
  assert.equal(f.fields['checker-run'].disabled, true);
  f.request().onProgress({ found: 2, expectedCount: 20 });
  assert.match(f.details.at(-1), /Scanning followers.*2 found so far/);
  assert.equal(f.fields['scan-bar'].attributes['aria-label'], 'List scan progress');
  assert.equal(f.fields['scan-bar'].attributes['aria-valuenow'], '10');
  f.context.shadow.activeElement = f.fields['list-scan-stop'];
  f.stop();
  assert.equal(f.request().signal.aborted, true);
  assert.equal(f.fields['list-scan-stop'].disabled, true);
  assert.equal(f.context.shadow.activeElement, f.fields['scan-detail']);
  assert.equal(f.fields['scan-detail'].tabIndex, -1);
  assert.equal(f.fields['scan-detail'].focusOptions.preventScroll, true);
  f.resolve(f.result({ reason: 'stopped' }));
  await pending;
  assert.equal(f.context.manualScanController, null);
  assert.equal(f.fields['list-scan-stop'].hidden, true);
  assert.equal(f.context.shadow.activeElement, f.fields['scan-detail'], 'settlement preserves the focused result detail');
  assert.equal(f.fields['checker-run'].disabled, false);
  assert.deepEqual(f.state.run.queue, ['untouched.target']);
  assert.equal(f.state.run.status, 'idle');
  assert.deepEqual(Array.from(f.state.capture.followers, row => row.username), ['previous.row', 'new.one', 'new.two']);
  assert.equal(f.state.capture.complete.followers, false);
  assert.equal(f.state.capture.verified.followers, true);
  assert.match(f.details.at(-1), /2 followers read; 3 stored.*partial/);
  assert.equal(f.fields['scan-bar'].attributes['aria-valuetext'], 'List scan stopped with a partial result');

  const switched = fixture(); const switchedPending = switched.scan('followers');
  switched.context.preferences.view = 'account';
  switched.context.shadow.activeElement = switched.fields['list-scan-stop'];
  switched.stop();
  assert.equal(switched.fields['scan-detail'].focusOptions, undefined, 'cancellation cannot steal focus into a different view');
  const otherToolControl = {};
  switched.context.shadow.activeElement = otherToolControl;
  switched.resolve(switched.result({ reason: 'stopped' })); await switchedPending;
  assert.equal(switched.context.shadow.activeElement, otherToolControl, 'a later settlement cannot steal focus back');
});

test('overlapping scans are refused before changing list choice or clearing progress', async () => {
  const f = fixture();
  const pending = f.scan('followers');
  f.request().onProgress({ found: 7, expectedCount: 20 });
  const lastDetail = f.details.at(-1);
  await assert.rejects(f.scan('following'), /already running/);
  assert.equal(f.fields['list-type'].value, 'followers');
  assert.equal(f.details.at(-1), lastDetail);
  assert.equal(f.scanButtons.get('scan-followers').disabled, true);
  f.resolve(f.result()); await pending;
  assert.equal(f.scanButtons.get('scan-followers').disabled, false);
});

test('manual/API scans and native activity owners exclude one another', async () => {
  for (const configure of [
    c => { c.relationshipController = new AbortController(); },
    c => { c.presencePanel = { busy: () => true }; },
    c => { c.inboxPanel = { busy: () => true }; },
    c => { c.dmCleanupController = new AbortController(); },
    c => { c.accountActionController = new AbortController(); },
    c => { c.dmRunner = { snapshot: () => ({ status: 'stopping', canStop: false }) }; },
    c => { c.state.run.status = 'running'; },
  ]) {
    const f = fixture(); configure(f.context);
    await assert.rejects(f.scan('followers'), /Stop|stop/);
    assert.equal(f.request(), undefined);
    assert.equal(f.fields['list-type'].value, 'following');
  }
  const f = fixture(); const pending = f.scan('followers');
  await f.context.checkAccountRelationships();
  await assert.rejects(f.context.scanSentConversation(), /Stop the list scan/);
  await f.context.runDmUnsend(); await f.context.runReactionsOnly();
  await f.context.startAccountRun({ action: 'follow', usernames: ['untouched.target'] });
  assert.ok(f.messages.slice(1).every(message => /Stop the list scan/.test(message)));
  const mountBusy = [...source.matchAll(/busy: \(\) => Boolean\(([\s\S]*?)\),/g)]
    .map(match => vm.runInContext(`Boolean(${match[1]})`, f.context));
  assert.equal(mountBusy.length, 3, 'Presence, Growth and inbox each receive the native-context guard');
  assert.ok(mountBusy.every(Boolean));
  f.resolve(f.result()); await pending;
});

test('capture and clear cannot replace the workspace while a read scan owns it', async () => {
  const f = fixture(); const original = f.state.capture;
  const pending = f.scan('followers');
  f.context.actions.capture(); f.context.actions['clear-capture']();
  assert.equal(f.state.capture, original);
  assert.equal(f.saved.length, 0);
  f.resolve(f.result()); await pending;
  assert.equal(f.saved.length, 1);
});

test('profile changes keep an old scan bound to its starting subject and partial', async () => {
  const f = fixture(); const pending = f.scan('followers');
  f.request().onProgress({ found: 1, expectedCount: 2 });
  const lastDetail = f.details.at(-1);
  f.context.location.pathname = '/different.owner/';
  f.request().onProgress({ found: 2, expectedCount: 2 });
  assert.equal(f.details.at(-1), lastDetail, 'old progress cannot update the new profile context');
  f.resolve(f.result({ complete: true, expectedCount: 2, reason: 'list-complete' }));
  await pending;
  assert.equal(f.state.capture.subjectUsername, 'fixture.owner');
  assert.equal(f.state.capture.complete.followers, false);
  assert.match(f.details.at(-1), /profile changed.*@fixture.owner.*partial/);
});

test('a late complete result after Stop is still saved only as a partial capture', async () => {
  const f = fixture(); const pending = f.scan('followers'); f.stop();
  f.resolve(f.result({ complete: true, expectedCount: 2, reason: 'list-complete' }));
  await pending;
  assert.equal(f.state.capture.complete.followers, false);
  assert.match(f.details.at(-1), /List scan stopped/);
});

test('stopping before new rows retains the previous verified inventory as partial', async () => {
  const f = fixture(); const pending = f.scan('followers'); f.stop();
  f.resolve(f.result({ accounts: [], observedCount: 0, reason: 'stopped' }));
  await pending;
  assert.deepEqual(Array.from(f.state.capture.followers, row => row.username), ['previous.row']);
  assert.equal(f.state.capture.complete.followers, false);
  assert.equal(f.state.capture.verified.followers, true);
  assert.match(f.details.at(-1), /0 followers read; 1 stored.*partial/);
});

test('a closed list or restricted session cannot turn collected rows into a complete result', async () => {
  for (const overrides of [{ reason: 'list-closed' }, { reason: 'session-stop', rateLimited: true }]) {
    const f = fixture(); const pending = f.scan('followers');
    f.resolve(f.result({ complete: true, expectedCount: 2, ...overrides }));
    await pending;
    assert.equal(f.state.capture.complete.followers, false);
    assert.equal(f.state.capture.followers.length, 3);
    assert.match(f.details.at(-1), /partial capture/);
  }
});

test('stale callbacks/results cannot overwrite a newer scan or a replaced workspace', async () => {
  for (const kind of ['controller', 'workspace']) {
    const f = fixture(); const pending = f.scan('followers');
    const nextController = new AbortController();
    if (kind === 'controller') f.context.manualScanController = nextController;
    else f.state.capture = { ...freshCapture(), subjectUsername: 'replacement.owner' };
    const before = f.details.length;
    f.request().onProgress({ found: 99, expectedCount: 100 });
    assert.equal(f.details.length, before);
    f.resolve(f.result({ complete: true }));
    if (kind === 'controller') {
      await pending;
      assert.equal(f.context.manualScanController, nextController);
      assert.equal(f.details.length, before);
    } else {
      await assert.rejects(pending, /saved capture changed/);
      assert.equal(f.state.capture.subjectUsername, 'replacement.owner');
      assert.equal(f.context.manualScanController, null);
    }
    assert.equal(f.saved.length, 0);
  }
});

test('collector errors release the read controller and settle the visible progress', async () => {
  const f = fixture(); const pending = f.scan('followers');
  f.reject(new Error('fixture-read-unavailable'));
  await assert.rejects(pending, /fixture-read-unavailable/);
  assert.equal(f.context.manualScanController, null);
  assert.equal(f.fields['list-scan-stop'].hidden, true);
  assert.match(f.details.at(-1), /List scan failed.*fixture-read-unavailable/);
  assert.equal(f.fields['scan-bar'].dataset.indeterminate, 'false');
  assert.equal(f.fields['scan-bar'].attributes['aria-valuetext'], 'List scan failed');
  assert.equal(f.saved.length, 0);
});

test('a setup error also releases the scan controller before the collector starts', async () => {
  const f = fixture();
  const render = f.context.renderAll;
  let renders = 0;
  f.context.renderAll = () => { if (++renders === 1) throw new Error('fixture-render-unavailable'); render(); };
  await assert.rejects(f.scan('followers'), /fixture-render-unavailable/);
  assert.equal(f.request(), undefined);
  assert.equal(f.context.manualScanController, null);
  assert.equal(f.fields['list-scan-stop'].hidden, true);
  assert.equal(f.saved.length, 0);
});

test('an independently verified empty list is saved as an empty complete capture', async () => {
  const f = fixture(); const pending = f.scan('followers');
  f.resolve(f.result({ accounts: [], observedCount: 0, expectedCount: 0, complete: true, reason: 'list-complete' }));
  await pending;
  assert.equal(f.state.capture.followers.length, 0);
  assert.equal(f.state.capture.complete.followers, true);
  assert.equal(f.state.capture.verified.followers, true);
});
