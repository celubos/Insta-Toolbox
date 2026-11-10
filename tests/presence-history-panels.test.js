import assert from 'node:assert/strict';
import test from 'node:test';
import { mountPresenceSessionPanel } from '../extension/presence-session-panel.js';
import { createPresenceSession } from '../extension/presence-session.js';
import { createPresenceHistoryJournal } from '../extension/presence-history-journal.js';
import { HistoryManager, hashHistoryValue, historyActor, legacyHistory, tickHistory } from './helpers/presence-history-storage.js';

class Element {
  constructor(tagName) { this.tagName = tagName; this.children = []; this.attributes = new Map(); this.listeners = new Map(); this.value = ''; this.checked = false; }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return (this.text || '') + this.children.map(child => child.textContent).join(''); }
  set value(value) { const text = String(value); this.selectedValue = this.tagName === 'select' ? this.children.some(option => option.value === text) ? text : '' : text; }
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
const actor = Object.freeze({ accountVerified: true, usable: true, accountId: 'fixture_owner_a', accountKey: historyActor });
function sharedLocks() {
  let active = false; const events = [];
  return { events, active: () => active,
    async request(name, options, callback) {
      assert.equal(options.mode, 'exclusive'); assert.equal(options.ifAvailable, true);
      if (active) return callback(null);
      active = true; events.push('acquired');
      try { return await callback({ name, mode: 'exclusive' }); }
      finally { active = false; events.push('released'); }
    } };
}
function mountTab(manager, name, at, locks, { inspectAccount = () => actor, execute } = {}) {
  const client = manager.open(name), document = { createElement: tag => new Element(tag), createTextNode: text => {
    const node = new Element('#text'); node.textContent = text; return node;
  } };
  const container = document.createElement('div'); let panel, journal, actions = 0;
  const downloads = [], messages = [], journals = new Map();
  const window = { document, Blob, setTimeout: () => 0,
    URL: { createObjectURL: blob => { downloads.push(blob); return 'blob:synthetic-history'; }, revokeObjectURL() {} },
    confirm: () => false };
  const session = createPresenceSession({ locks, now: () => at,
    nativeActions: { inspectContext: inspectAccount,
      find: async action => ({ action, id: name + '_synthetic_post', label: name + ' synthetic post' }),
      execute: async () => { actions += 1; return execute ? execute(actions)
        : { verified: true, label: name + ' synthetic post', reason: 'Synthetic outcome' }; } },
    onUpdate: value => panel?.render(value),
  });
  panel = mountPresenceSessionPanel({ container, document, window, session, now: () => at,
    inspectAccount, confirmAction: async ({ binding }) => binding,
    readPreferences: () => ({ actions: { likePosts: true }, mode: 'session', maxActions: 1 }), writePreferences: () => {},
    createHistoryStore: accountKey => {
      assert.ok([historyActor, 'fixture_key_b'].includes(accountKey));
      journal = createPresenceHistoryJournal({ accountKey, storage: client.storage, readLegacy: () => client.readLegacy(accountKey),
        randomId: client.randomId, hash: hashHistoryValue, now: () => at });
      journals.set(accountKey, journal); return journal;
    }, onStatus: message => messages.push(message),
  });
  return { panel, session, client, window, container, downloads, messages,
    journal: () => journal, journalFor: key => journals.get(key), actions: () => actions,
    control: label => container.all().find(node => node.tagName === 'button' && node.textContent === label),
  };
}

test('actual two mounted panels and serial Presence sessions retain95+A3+B3 through the production private journal', async () => {
  const manager = new HistoryManager(); manager.seed(); const locks = sharedLocks();
  const a = mountTab(manager, 'tab_a', 1_800_000_000_000, locks);
  const b = mountTab(manager, 'tab_b', 1_800_000_010_000, locks);
  assert.ok(a.journal()); assert.ok(b.journal());
  await a.journal().refresh(); await b.journal().refresh();
  assert.equal(a.journal().snapshot().entries.length, 95); assert.equal(b.journal().snapshot().entries.length, 95);
  assert.equal(await a.panel.begin(), true); await a.journal().settled();
  assert.equal(a.actions(), 1); assert.equal(locks.active(), false);
  const first = a.journal().snapshot().entries.filter(entry => !entry.eventId.startsWith('retained_')).map(entry => entry.eventId);
  assert.equal(first.length, 3, 'real session/panel append started, synthetic native outcome and terminal records');
  a.panel.dispose(); a.client.close();
  assert.equal(b.journal().snapshot().entries.length, 95, 'second tab deliberately has not received remote manager changes');
  assert.equal(await b.panel.begin(), true); await b.journal().settled();
  assert.equal(b.actions(), 1); assert.equal(b.journal().snapshot().entries.length, 98);
  const second = b.journal().snapshot().entries.filter(entry => !entry.eventId.startsWith('retained_')).map(entry => entry.eventId);
  assert.equal(first.some(id => second.includes(id)), false, 'review/run/event IDs are distinct rather than deduplicated accidentally');
  assert.deepEqual(locks.events, ['acquired', 'released', 'acquired', 'released']);
  const reader = manager.open('fresh_reader');
  const stored = createPresenceHistoryJournal({ accountKey: historyActor, storage: reader.storage,
    readLegacy: () => reader.readLegacy(historyActor), randomId: reader.randomId, hash: hashHistoryValue });
  await stored.refresh();
  assert.equal(stored.snapshot().entries.length, 101);
  assert.ok([...first, ...second].every(id => stored.snapshot().entries.some(entry => entry.eventId === id)));
  b.client.deliverRemote();
  const log = b.container.all().find(node => node.className === 'presence-log');
  log.open = true; log.fire('toggle'); await tickHistory(); await b.journal().refresh();
  assert.equal(b.journal().snapshot().entries.length, 101);
  await b.control('Download log').fire('click'); await tickHistory();
  assert.equal(b.downloads.length, 1);
  const exported = JSON.parse(await b.downloads[0].text());
  assert.equal(exported.schemaVersion, 1); assert.equal(exported.entries.length, 101);
  assert.equal(exported.globallyFresh, false);
  assert.deepEqual(manager.values.get('instaToolboxPresenceActivityLogV1:' + historyActor), legacyHistory);
  b.panel.dispose(); stored.dispose();
});

test('an actual settling Presence session keeps its journal on actorA while actorB becomes visible and runs later', async () => {
  const manager = new HistoryManager(); manager.seed(); manager.seed('fixture_key_b');
  const actorB = { ...actor, accountId: 'fixture_owner_b', accountKey: 'fixture_key_b' };
  let current = actor, finish;
  const mounted = mountTab(manager, 'switching', 1_800_000_030_000, sharedLocks(), {
    inspectAccount: () => current,
    execute: count => count === 1 ? new Promise(resolve => { finish = resolve; })
      : { verified: true, label: 'Synthetic B post', reason: 'Synthetic B outcome' },
  });
  const historyA = mounted.journalFor(historyActor); await historyA.refresh();
  const runA = mounted.panel.begin(); await tickHistory();
  assert.equal(typeof finish, 'function');
  current = actorB; mounted.panel.render();
  const historyB = mounted.journalFor('fixture_key_b'); assert.ok(historyB); await historyB.refresh();
  assert.equal(historyB.snapshot().entries.length, 95);
  finish({ verified: true, label: 'Synthetic already-dispatched A post', reason: 'Synthetic A settlement' });
  assert.equal(await runA, true); await historyA.settled();
  assert.equal(historyA.snapshot().entries.length, 98);
  assert.equal(historyB.snapshot().entries.length, 95, 'lateA action/terminal rows never enter B storage');
  assert.equal(await mounted.panel.begin(), true); await historyB.settled();
  assert.equal(historyB.snapshot().entries.length, 98);
  assert.equal(historyA.snapshot().entries.length, 98);
  assert.equal(historyB.snapshot().entries.some(entry => /already-dispatched A/.test(entry.target)), false);
  current = actor; mounted.panel.render(); await historyA.refresh();
  assert.equal(historyA.snapshot().entries.length, 98);
  assert.ok(historyA.snapshot().entries.some(entry => /already-dispatched A/.test(entry.target)));
  mounted.panel.dispose();
});
