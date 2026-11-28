import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const [labelsSource, inspectorSource] = await Promise.all([
  readFile(new URL('../extension/action-labels.js', import.meta.url), 'utf8'),
  readFile(new URL('../extension/content-instagram.js', import.meta.url), 'utf8'),
]);
// Expose the private reader in this VM only; exercise its real header and modal
// proofs without adding a production API just for tests.
const exportMarker = '  globalThis.InstaToolboxInstagramInspector = Object.freeze({';
const testSource = inspectorSource.replace(exportMarker,
  `  globalThis.readExactListCount = exactProfileListCount;\n${exportMarker}`);
assert.ok(testSource !== inspectorSource, 'the Inspector export marker must be present');

function fixture() {
  function node(tagName, textContent = '', attributes = {}) {
    return {
      tagName, textContent, attributes: { ...attributes }, children: [], parentElement: null,
      connected: true, hidden: false, rectCount: 1,
      style: { display: 'block', visibility: 'visible', opacity: '1' },
      get isConnected() { return this.connected && (!this.parentElement || this.parentElement.isConnected); },
      getAttribute(name) { return this.attributes[name] ?? null; },
      getClientRects() { return this.isConnected ? Array(this.rectCount).fill({}) : []; },
      contains(other) { return other === this || this.children.some(child => child.contains(other)); },
      closest(selector) {
        for (let current = this; current; current = current.parentElement) {
          if (selector.split(',').some(part => {
            const match = part.trim().match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
            return match && (match[2] === undefined
              ? (match[1] === 'hidden' && current.hidden) || current.getAttribute(match[1]) !== null
              : current.getAttribute(match[1]) === match[2]);
          })) return current;
        }
        return null;
      },
      querySelectorAll() { return []; },
      querySelector() { return null; },
    };
  }
  function attach(parent, ...children) {
    for (const child of children) {
      if (child.parentElement) {
        child.parentElement.children = child.parentElement.children.filter(other => other !== child);
      }
      child.parentElement = parent; parent.children.push(child);
    }
  }
  const body = node('BODY'); body.innerText = '';
  const backdrop = node('DIV', '', { 'aria-hidden': 'true' });
  const header = node('HEADER', 'fixture_owner 123 followers 45 following');
  const owner = node('A', 'fixture_owner', { href: '#', role: 'link' });
  const followers = node('A', '123 followers', { href: '/fixture_owner/', role: 'link' });
  const following = node('A', '45 following', { href: '/fixture_owner/', role: 'link' });
  following.rectCount = 3;
  const counters = [followers, following];
  header.querySelectorAll = selector => selector === 'a[href], h1, h2, [role="heading"]'
    ? [owner, ...counters] : [];
  const modal = node('DIV', 'Following\nSearch\nSynthetic rows', { role: 'dialog' });
  attach(body, backdrop, modal); attach(backdrop, header); attach(header, owner, ...counters);
  const state = {
    body, backdrop, header, owner, followers, following, counters, modal,
    headers: [header], dialogs: [modal], unscoped: [], node, attach,
    location: { origin: 'https://www.instagram.com', pathname: '/fixture_owner/' },
  };
  const document = {
    body,
    querySelector: () => null,
    querySelectorAll(selector) {
      if (selector === 'main header') return state.headers;
      if (selector === '[role="dialog"]') return state.dialogs;
      if (selector === 'a[role="link"], a[href="#"]') return [owner, ...counters, ...state.unscoped];
      return [];
    },
  };
  const context = vm.createContext({
    URL, AbortController, setTimeout, clearTimeout,
    document, location: state.location, getComputedStyle: element => element.style,
  });
  vm.runInContext(labelsSource, context);
  vm.runInContext(testSource, context);
  state.read = (listType = 'following', options = {}) => context.readExactListCount(listType, options);
  state.collect = options => context.InstaToolboxInstagramInspector.collectAccountList(options);
  state.listRows = count => {
    const rows = Array.from({ length: count }, (_, index) =>
      node('A', `list_person${index}`, { href: `/list_person${index}/` }));
    attach(modal, ...rows);
    modal.querySelectorAll = selector => selector === 'a[href^="/"]' ? rows : [];
    following.textContent = `${count} following`;
  };
  return state;
}

test('a single native list modal permits its fresh mounted owner counter behind an aria-hidden backdrop', () => {
  const f = fixture();
  assert.equal(f.read(), 45);
  assert.equal(f.read('following', { requireScoped: true }), 45);
  f.following.attributes.href = '#';
  assert.equal(f.read(), 45, 'the exact owner header can contain a non-navigation counter');
  f.following.attributes.href = '/fixture_owner/following/';
  assert.equal(f.read(), 45);
  assert.equal(f.read('followers'), null, 'the exception must match the open list type');
  f.modal.textContent = 'Followers\nSearch\nSynthetic rows';
  assert.equal(f.read('followers'), 123);
  assert.equal(f.read(), null);
});

test('an unrelated, hidden, missing, or ambiguous modal cannot expose backdrop counts', () => {
  const mutations = [
    f => { f.dialogs = []; },
    f => { f.modal.textContent = 'Settings'; },
    f => { f.modal.attributes['aria-label'] = 'Followers'; },
    f => { f.modal.attributes['aria-hidden'] = 'true'; },
    f => { f.modal.hidden = true; },
    f => { f.modal.style.display = 'none'; },
    f => { f.attach(f.backdrop, f.modal); },
    f => {
      const other = f.node('DIV', 'Settings', { role: 'dialog' });
      f.attach(f.body, other); f.dialogs.push(other);
    },
  ];
  for (const mutate of mutations) {
    const f = fixture(); mutate(f);
    assert.equal(f.read(), null, mutate.toString());
  }
});

test('backdrop counters require the unique current owner header and physical visibility', () => {
  const mutations = [
    f => { f.owner.textContent = 'different_owner'; },
    f => { f.location.pathname = '/different_owner/'; },
    f => { f.location.pathname = '/fixture_owner/following/'; },
    f => { f.location.origin = 'https://example.com'; },
    f => { f.headers.push({ ...f.header }); },
    f => { f.header.connected = false; },
    f => { f.header.rectCount = 0; },
    f => { f.header.hidden = true; },
    f => { f.header.attributes['aria-hidden'] = 'true'; },
    f => { f.header.style.visibility = 'hidden'; },
    f => { f.backdrop.style.display = 'none'; },
    f => { f.backdrop.style.opacity = '0'; },
    f => { f.following.rectCount = 0; },
    f => { f.following.hidden = true; },
    f => { f.following.attributes['aria-hidden'] = 'true'; },
    f => {
      const hiddenGroup = f.node('DIV', '', { 'aria-hidden': 'true' });
      f.attach(f.header, hiddenGroup); f.attach(hiddenGroup, f.following);
    },
  ];
  for (const mutate of mutations) {
    const f = fixture(); mutate(f);
    assert.equal(f.read(), null, mutate.toString());
  }
});

test('new backdrop evidence cannot fall back to a foreign or unscoped counter', () => {
  for (const href of ['/different_owner/following/', 'https://example.com/fixture_owner/',
    '/fixture_owner/?unrelated=1', '/fixture_owner/#unrelated']) {
    const f = fixture(); f.following.attributes.href = href;
    assert.equal(f.read(), null, href);
  }
  const f = fixture();
  f.counters.splice(f.counters.indexOf(f.following), 1);
  f.attach(f.backdrop, f.following); f.unscoped.push(f.following);
  assert.equal(f.read(), null, 'a matching route outside the owner header is insufficient');
});

test('count reads stay fresh and conflicting header totals remain unknown', () => {
  const f = fixture();
  assert.equal(f.read(), 45);
  f.following.textContent = '46 following';
  assert.equal(f.read(), 46, 'the modal does not authorize a cached old total');
  const conflict = f.node('A', '47 following', { href: '#', role: 'link' });
  f.attach(f.header, conflict); f.counters.push(conflict);
  assert.equal(f.read(), null);
  f.counters.pop();
  f.location.pathname = '/different_owner/';
  assert.equal(f.read(), null, 'the previously proved profile cannot survive a route change');
});

test('ordinary visible profile counters keep their existing behavior', () => {
  const f = fixture(); delete f.backdrop.attributes['aria-hidden'];
  f.modal.textContent = 'Settings';
  assert.equal(f.read(), 45);
  assert.equal(f.read('followers', { requireScoped: true }), 123);
});

test('the collector uses backdrop totals and a fresh count change forces a partial result', async () => {
  const baseline = fixture(); baseline.listRows(3);
  const complete = await baseline.collect({ listType: 'following', settleMs: 0 });
  assert.equal(complete.complete, true);
  assert.equal(complete.expectedCount, 3);
  assert.equal(complete.observedCount, 3);

  const changed = fixture(); changed.listRows(3);
  const result = await changed.collect({
    listType: 'following', settleMs: 0,
    onProgress: () => { changed.following.textContent = '4 following'; },
  });
  assert.equal(result.accounts.length, 3);
  assert.equal(result.expectedCount, 4);
  assert.equal(result.observedCount, 3);
  assert.equal(result.complete, false);
  assert.equal(result.reason, 'list-count-changed');
});

test('an end counter disappearing cannot reuse the starting total as completion proof', async () => {
  const f = fixture(); f.listRows(3);
  const result = await f.collect({ listType: 'following', settleMs: 0,
    onProgress: () => {
      f.counters.splice(f.counters.indexOf(f.following), 1);
      f.following.connected = false;
    } });
  assert.equal(f.headers.length, 1);
  assert.equal(f.owner.textContent, 'fixture_owner');
  assert.equal(f.location.pathname, '/fixture_owner/');
  assert.equal(f.modal.textContent, 'Following\nSearch\nSynthetic rows');
  assert.equal(result.accounts.length, 3);
  assert.equal(result.expectedCount, 3, 'the initial total remains useful progress context');
  assert.equal(result.complete, false);
  assert.equal(result.reason, 'list-count-unverified');
});

test('Stop keeps an exact backdrop-count inventory partial rather than claiming completion', async () => {
  const f = fixture(); f.listRows(3);
  const controller = new AbortController();
  const result = await f.collect({
    listType: 'following', settleMs: 0, signal: controller.signal,
    onProgress: () => controller.abort(),
  });
  assert.equal(result.accounts.length, 3);
  assert.equal(result.expectedCount, 3);
  assert.equal(result.observedCount, 3);
  assert.equal(result.listType, 'following');
  assert.equal(result.complete, false);
  assert.equal(result.reason, 'stopped');
});

test('a foreign modal cannot make the collector claim a hidden-header list is complete', async () => {
  const foreign = fixture(); foreign.listRows(3); foreign.modal.textContent = 'Settings';
  const unrelated = await foreign.collect({ listType: 'following', settleMs: 0 });
  assert.equal(unrelated.accounts.length, 0);
  assert.equal(unrelated.complete, false);
  assert.equal(unrelated.reason, 'open-a-followers-or-following-list');

  const ambiguous = fixture(); ambiguous.listRows(3);
  const other = ambiguous.node('DIV', 'Settings', { role: 'dialog' });
  ambiguous.attach(ambiguous.body, other); ambiguous.dialogs.push(other);
  const result = await ambiguous.collect({ listType: 'following', settleMs: 0 });
  assert.equal(result.accounts.length, 3, 'readable list rows remain available as partial data');
  assert.equal(result.expectedCount, null);
  assert.equal(result.complete, false);
  assert.equal(result.reason, 'list-count-unverified');
});

test('a changed owner header stops the collector even before the route finishes changing', async () => {
  const f = fixture(); f.listRows(3);
  const result = await f.collect({ listType: 'following', settleMs: 0,
    onProgress: () => { f.owner.textContent = 'different_owner'; } });
  assert.equal(result.accounts.length, 3);
  assert.equal(result.expectedCount, 3);
  assert.equal(result.complete, false);
  assert.equal(result.reason, 'profile-changed');
  assert.equal(result.profilePath, '/fixture_owner/');
});
