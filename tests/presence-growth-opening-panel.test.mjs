import assert from 'node:assert/strict';
import test from 'node:test';
import { mountPresenceGrowthPanel } from '../extension/presence-growth-panel.js';
import { createGrowthReadDraft } from '../extension/presence-growth-draft.js';

const NOW = Date.parse('2026-02-01T12:00:00.000Z');
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const iso = value => new Date(value).toISOString();
const retired = (status = 404) => Object.assign(new Error('Existing lookup routes retired.'), {
  code: 'request-failed', httpStatus: status, lookupRoutesRetired: true,
});
const nativeRow = username => ({ username, source: 'extension-scrolled-dom',
  profileUrl: `https://www.instagram.com/${username}/`, displayName: '' });
const apiRow = username => ({ ...nativeRow(username), source: 'authenticated-instagram-web' });

function nativeResult(username, clock, overrides = {}) {
  return { username, source: 'list-dialog', capturedAt: iso(clock),
    followers: [nativeRow('candidate')], following: [nativeRow('candidate')],
    verified: { followers: true, following: true },
    complete: { followers: true, following: true },
    expectedCounts: { followers: 1, following: 1 },
    pages: { followers: null, following: null },
    reasons: { followers: 'native-list-complete', following: 'native-list-complete' },
    ...overrides };
}

function apiResult(username, clock) {
  return { username, userId: '77', subjectInstagramId: '77', source: 'authenticated-instagram-web',
    capturedAt: iso(clock), followers: [apiRow('candidate')], following: [apiRow('candidate')],
    complete: { followers: true, following: true }, expectedCounts: { followers: 1, following: 1 },
    pages: { followers: 1, following: 1 }, reasons: { followers: 'pagination-complete', following: 'pagination-complete' } };
}

class Element {
  constructor(tag) {
    this.tagName = tag.toLowerCase(); this.children = []; this.parentElement = null;
    this.value = ''; this.checked = false; this.disabled = false; this.hidden = false;
    this.attributes = {}; this.listeners = new Map(); this.dataset = {};
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return (this.text || '') + this.children.map(child => child.textContent).join(''); }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_all, letter) => letter.toUpperCase())] = String(value);
  }
  getAttribute(name) { return this.attributes[name] ?? null; }
  append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
  prepend(...children) { for (const child of children) child.parentElement = this; this.children.unshift(...children); }
  replaceChildren(...children) { this.children = []; this.text = ''; this.append(...children); }
  querySelectorAll(selector) {
    const descendants = this.children.flatMap(node => [node, ...node.querySelectorAll('*')]);
    if (selector === '*') return descendants;
    if (selector === 'input:checked') return descendants.filter(node => node.tagName === 'input' && node.checked);
    if (selector === 'a[href]') return descendants.filter(node => node.tagName === 'a' && (node.href || node.getAttribute('href')));
    if (/^[a-z]+$/.test(selector)) return descendants.filter(node => node.tagName === selector);
    return [];
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(listener); }
  removeEventListener(type, listener) { this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== listener)); }
  dispatch(type) { for (const listener of this.listeners.get(type) || []) listener({ type, target: this, currentTarget: this }); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); }
}

function environment(seedCount = 1) {
  const seeds = ['seed_a', 'seed_b', 'seed_c'].slice(0, seedCount);
  return { clock: NOW, actor: 'owner', usable: true, profile: 'owner', seeds, store: null,
    followingSnapshot: { subjectUsername: 'owner', listType: 'following', verified: true,
      source: 'list-dialog', capturedAt: iso(NOW - 1_000), complete: true,
      accounts: seeds.map(nativeRow) },
    campaigns: [], runs: [], reviews: [], statuses: [], apiCalls: [], nativeCalls: [], writes: [],
    readAccountCalls: [], readStorageContexts: [], writeStorageContexts: [],
    approval: false, failWrites: false,
    inspectRead() { return null; },
    async api() { throw retired(); },
    async native(username) { return nativeResult(username, this.clock); },
  };
}

function mount(env) {
  const document = { createElement: tag => new Element(tag), createTextNode: text => {
    const node = new Element('#text'); node.textContent = text; return node;
  } };
  const container = document.createElement('div');
  const listeners = new Map();
  const window = { addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: (type, listener) => { if (listeners.get(type) === listener) listeners.delete(type); } };
  const panel = mountPresenceGrowthPanel({ container, document, window,
    inspectAccount: () => ({ accountVerified: env.usable, usable: env.usable, accountId: env.actor }),
    inspectReadAccount: context => { env.readAccountCalls.push(copy(context)); return env.inspectRead(context); },
    readFollowing: () => copy(env.followingSnapshot.accounts), readFollowers: () => [],
    readFollowingSnapshot: () => copy(env.followingSnapshot),
    readReadDraft: (actor, seed) => {
      env.readStorageContexts.push({ actor, seed });
      return copy(typeof env.readDraft === 'function' ? env.readDraft(actor, seed) : env.store);
    },
    writeReadDraft: (value, actor, seed) => {
      if (env.failWrites) throw new Error('fixture-storage-write-failed');
      env.store = copy(value); env.writes.push(copy(value)); env.writeStorageContexts.push({ actor, seed });
    },
    readCurrentProfile: () => env.profile,
    scanSeed: async (username, signal, onProgress) => {
      env.apiCalls.push({ username, signal }); return env.api(username, signal, onProgress);
    },
    readSeedNative: async (username, signal, onProgress, onReadContext) => {
      env.nativeCalls.push({ username, signal, onProgress }); return env.native(username, signal, onProgress, onReadContext);
    },
    readCampaigns: () => { env.campaignReads = (env.campaignReads || 0) + 1; return env.campaigns; },
    writeCampaigns: value => { env.campaigns = value; },
    confirmAction: async options => {
      env.reviews.push(options); return typeof env.approval === 'function' ? env.approval(options) : env.approval ? options.binding : null;
    },
    runBatch: async run => { env.runs.push(run); },
    busy: () => env.externalBusy === true,
    onStatus: value => env.statuses.push(value), now: () => env.clock,
  });
  const all = () => container.querySelectorAll('*');
  return { panel, container, all, input: all().find(node => node.tagName === 'input' && node.type === 'text'),
    links: () => all().filter(node => node.tagName === 'a').map(node => node.href || node.getAttribute('href')),
    text: () => container.textContent };
}

async function startDraft(env, app = mount(env)) {
  app.input.value = env.seeds.join(', ');
  await app.panel.findCandidates();
  assert.ok(env.store, 'retired lookup persists a read-only draft');
  assert.equal(env.nativeCalls.length, 0, 'discovery never automatically starts a native read');
  return app;
}


test('Growth keeps a qualified opening alive past its monitor tick without account-scoped storage access', async () => {
  const env = environment(); const app = await startDraft(env); env.profile = 'seed_a';
  const initial = copy(env.store); let opening = false, reads = 0;
  env.readDraft = () => { if (opening) reads += 1; return env.store; };
  env.native = (_username, signal, onProgress, onReadContext) => new Promise((resolve, reject) => {
    onReadContext?.({ phase: 'opening', validate: () => !signal.aborted });
    opening = true;
    env.usable = false;
    setTimeout(() => {
      try {
        assert.equal(signal.aborted, false, 'the 100 ms monitor waits under fresh flow-only proof');
        assert.equal(reads, 0, 'opening does not access account-scoped draft storage');
        assert.deepEqual(env.store, initial); assert.deepEqual(env.runs, []);
        opening = false; env.usable = true; onReadContext?.({ phase: 'ready' });
        onProgress({ phase: 'native-reading', listType: 'followers', found: 1 });
        resolve(nativeResult('seed_a', env.clock));
      } catch (error) { reject(error); }
    }, 240);
  });
  try {
    await app.panel.readCurrentSeed();
    assert.ok(env.store.results.seed_a); assert.deepEqual(env.runs, []);
  } finally { app.panel.dispose(); }
});

async function beginOpening(env, app, { ordinary = false } = {}) {
  let finish, signal, progressCalls = 0;
  env.opening = false; env.guardValid = true;
  env.native = (_username, activeSignal, onProgress, onReadContext) => new Promise((resolve, reject) => {
    signal = activeSignal;
    signal.addEventListener('abort', () => reject(Object.assign(new Error('Read stopped.'), { code: 'stopped' })), { once: true });
    env.opening = true;
    onReadContext({ phase: 'opening', validate: () => env.guardValid && !signal.aborted });
    env.usable = ordinary;
    finish = () => {
      try {
        env.opening = false; env.usable = true; onReadContext({ phase: 'ready' });
        progressCalls += 1; onProgress({ phase: 'native-reading', listType: 'followers', found: 1 });
        resolve(nativeResult('seed_a', env.clock));
      } catch (error) { reject(error); }
    };
  });
  const pending = app.panel.readCurrentSeed();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(signal, 'explicit native read started');
  return { pending, signal, finish: () => finish(), progressCalls: () => progressCalls };
}

for (const [name, change] of [
  ['fresh actor proof loss', (env) => { env.guardValid = false; }],
  ['current profile change', (env) => { env.profile = 'different_seed'; }],
  ['selected seed edit', (_env, app) => { app.input.value = 'different_seed'; }],
  ['Following basis drift', (env) => { env.followingSnapshot.accounts.push(nativeRow('new_connection')); }],
  ['draft expiry', (env) => { env.clock = env.store.expiresAt + 1; }],
]) {
  test(`Growth opening stops on ${name} and retains prior saved reads`, async () => {
    const env = environment(), app = await startDraft(env); env.profile = 'seed_a';
    const original = copy(env.store), writes = env.writes.length;
    const job = await beginOpening(env, app);
    try {
      change(env, app);
      await job.pending;
      assert.equal(job.signal.aborted, true);
      assert.deepEqual(env.store, original); assert.equal(env.writes.length, writes);
      assert.equal(job.progressCalls(), 0); assert.deepEqual(env.runs, []); assert.deepEqual(env.reviews, []);
    } finally { app.panel.dispose(); }
  });
}

test('Growth Stop during opening performs no draft or campaign storage IO and creates no approval', async () => {
  const env = environment(), app = await startDraft(env); env.profile = 'seed_a';
  const original = copy(env.store), writes = env.writes.length;
  const job = await beginOpening(env, app, { ordinary: true });
  const reads = env.readStorageContexts.length, campaigns = env.campaignReads;
  try {
    await app.panel.reviewDue(); await app.panel.reviewFollow();
    assert.equal(env.readStorageContexts.length, reads); assert.equal(env.campaignReads, campaigns);
    app.panel.stopSearch(); await job.pending;
    assert.deepEqual(env.store, original); assert.equal(env.writes.length, writes);
    assert.equal(job.progressCalls(), 0); assert.deepEqual(env.runs, []); assert.deepEqual(env.reviews, []);
  } finally { app.panel.dispose(); }
});

test('Growth rechecks account-scoped stored draft continuity before the first qualified row', async () => {
  const env = environment(), app = await startDraft(env); env.profile = 'seed_a';
  const job = await beginOpening(env, app);
  const changed = copy(env.store); changed.id = 'changed-in-another-tab'; env.store = changed;
  const writes = env.writes.length;
  try {
    job.finish(); await job.pending;
    assert.equal(job.signal.aborted, true); assert.equal(job.progressCalls(), 0);
    assert.deepEqual(env.store, changed); assert.equal(env.writes.length, writes);
    assert.deepEqual(env.runs, []); assert.deepEqual(env.reviews, []);
  } finally { app.panel.dispose(); }
});

test('Growth keeps an opening timeout actionable rather than reporting it as a user Stop', async () => {
  const env = environment(), app = await startDraft(env); env.profile = 'seed_a';
  const original = copy(env.store), writes = env.writes.length;
  env.native = (_username, signal, _onProgress, onReadContext) => new Promise((_resolve, reject) => {
    onReadContext({ phase: 'opening', validate: () => !signal.aborted }); env.usable = false;
    setTimeout(() => {
      onReadContext(null);
      reject(Object.assign(new Error('Instagram is still loading this native list. Let it finish and retry.'), {
        code: 'native-list-loading-timeout',
      }));
    }, 240);
  });
  try {
    await app.panel.readCurrentSeed();
    assert.match(env.statuses.at(-1), /still loading.*retry/);
    assert.doesNotMatch(env.statuses.at(-1), /Search stopped/);
    assert.deepEqual(env.store, original); assert.equal(env.writes.length, writes);
    assert.deepEqual(env.runs, []); assert.deepEqual(env.reviews, []);
  } finally { app.panel.dispose(); }
});

test('Growth checks stored draft continuity before opening the next native list', async () => {
  const env = environment(), app = await startDraft(env); env.profile = 'seed_a';
  let nextListClicks = 0;
  env.native = async (_username, signal, onProgress, onReadContext) => {
    onReadContext({ phase: 'opening', validate: () => !signal.aborted });
    onReadContext({ phase: 'ready' });
    onProgress({ phase: 'native-reading', listType: 'followers', found: 1 });
    env.store = { ...env.store, id: 'concurrent-draft-before-following' };
    onReadContext({ phase: 'opening', validate: () => !signal.aborted });
    nextListClicks += 1;
    return nativeResult('seed_a', env.clock);
  };
  const writes = env.writes.length;
  try {
    await app.panel.readCurrentSeed();
    assert.equal(nextListClicks, 0, 'a changed draft cannot open Following');
    assert.equal(env.writes.length, writes);
    assert.equal(env.store.id, 'concurrent-draft-before-following');
    assert.deepEqual(env.runs, []); assert.deepEqual(env.reviews, []);
  } finally { app.panel.dispose(); }
});
