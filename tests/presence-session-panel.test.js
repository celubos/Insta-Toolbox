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
