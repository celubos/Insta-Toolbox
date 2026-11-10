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
}

function fixture({ confirm = async ({ binding }) => binding, saved = null } = {}) {
  const document = { createElement: tag => new Element(tag), createTextNode: text => {
    const node = new Element('#text'); node.textContent = text; return node;
  } };
  const container = document.createElement('div');
  const starts = [];
  const messages = [];
  let preferences = saved || { actions: { likePosts: true }, mode: 'session', maxActions: 10 };
  let snapshot = { status: 'idle', results: [], completed: 0 };
  const session = {
    snapshot: () => snapshot,
    createReview: value => ({ ...value, reviewedDigest: 'fixture-review' }),
    start: async review => {
      starts.push(review);
      snapshot = { status: 'completed', completed: 1, maxActions: review.options.maxActions, results: [] };
      return snapshot;
    },
    stop: () => false,
  };
  const panel = mountPresenceSessionPanel({ container, document, session,
    window: {}, now: () => 1_800_000_000_000,
    inspectAccount: () => ({ accountVerified: true, usable: true, accountId: 'fixture_owner' }),
    confirmAction: confirm,
    readPreferences: () => preferences,
    writePreferences: value => { preferences = value; },
    onStatus: message => messages.push(message),
  });
  const attr = name => container.all().find(node => node.attributes.has(name));
  const start = () => attr('data-presence-start');
  return { panel, container, attr, starts, messages, start,
    preferences: () => preferences,
    render: value => { snapshot = value; panel.render(value); },
  };
}

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
