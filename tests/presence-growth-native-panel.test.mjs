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
    readSeedNative: async (username, signal, onProgress) => {
      env.nativeCalls.push({ username, signal, onProgress }); return env.native(username, signal, onProgress);
    },
    readCampaigns: () => env.campaigns, writeCampaigns: value => { env.campaigns = value; },
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

async function settleStarted(env, expected = 1) {
  for (let attempt = 0; attempt < 10 && env.nativeCalls.length < expected; attempt += 1) await new Promise(resolve => setImmediate(resolve));
  assert.equal(env.nativeCalls.length, expected, 'explicit native read started');
}

async function waitUntil(predicate, message) {
  const deadline = Date.now() + 1_500;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(predicate(), true, message);
}

function startupDraftEnvironment() {
  const env = environment(3);
  env.followingSnapshot.complete = false;
  env.store = copy(createGrowthReadDraft({ actor: env.actor, followingSnapshot: env.followingSnapshot,
    seeds: env.seeds, now: env.clock, id: 'saved-startup-draft' }));
  env.usable = false;
  env.profile = 'seed_a';
  env.managerReads = 0;
  env.readDraft = actor => {
    if (!env.usable || actor !== env.actor) return null;
    env.managerReads += 1;
    return env.store?.actor === actor ? env.store : null;
  };
  return env;
}

const waitForContextCheck = () => new Promise(resolve => setTimeout(resolve, 550));

test('a three-seed read-only draft restores after delayed actor verification without polling storage or starting work', async () => {
  const env = startupDraftEnvironment();
  const original = copy(env.store);
  const app = mount(env);
  try {
    assert.equal(app.input.value, '');
    assert.deepEqual(app.links(), []);
    assert.equal(env.managerReads, 0, 'an unverified actor cannot reach account-scoped storage');
    await waitForContextCheck();
    assert.equal(env.managerReads, 0, 'waiting for the actor is not a storage poll');
    env.usable = true;
    await waitUntil(() => app.input.value.replace(/\s/g, '') === env.seeds.join(','),
      'the same verified actor restores the saved three selected seeds');
    assert.deepEqual(app.links(), env.seeds.map(seed => `https://www.instagram.com/${seed}/`));
    assert.equal(app.panel.busy(), false);
    const readsAfterRestore = env.managerReads;
    assert.ok(readsAfterRestore > 0);
    await waitForContextCheck();
    assert.equal(env.managerReads, readsAfterRestore, 'an unchanged verified context does not poll stored drafts every tick');
    assert.deepEqual(env.store, original, 'restoration changes no stored read evidence');
    assert.deepEqual(env.writes, []);
    assert.deepEqual(env.apiCalls, []); assert.deepEqual(env.nativeCalls, []);
    assert.deepEqual(env.reviews, []); assert.deepEqual(env.runs, []); assert.deepEqual(env.campaigns, []);
    app.input.value = 'my_new_choice';
    env.usable = false;
    await waitForContextCheck();
    env.usable = true;
    await waitForContextCheck();
    assert.equal(app.input.value, 'my_new_choice', 'later actor changes never replay the startup restore over new intent');
  } finally { app.panel.dispose(); }
});

test('delayed startup restoration rejects switched owners, changed routes and Following evidence, expiry and malformed drafts', async () => {
  for (const change of ['new-owner', 'new-owner-with-own-draft', 'route', 'following', 'expired', 'malformed']) {
    const env = startupDraftEnvironment();
    const app = mount(env);
    try {
      if (change === 'new-owner' || change === 'new-owner-with-own-draft') env.actor = 'another_owner';
      if (change === 'new-owner-with-own-draft') {
        env.followingSnapshot.subjectUsername = env.actor;
        env.store = copy(createGrowthReadDraft({ actor: env.actor, followingSnapshot: env.followingSnapshot,
          seeds: env.seeds, now: env.clock, id: 'different-owner-draft' }));
      }
      if (change === 'route') env.profile = 'seed_b';
      if (change === 'following') env.followingSnapshot.accounts.push(nativeRow('newly_followed'));
      if (change === 'expired') env.clock += 31 * 60_000;
      if (change === 'malformed') env.store.approvedTargets = ['candidate'];
      const retained = copy(env.store);
      env.usable = true;
      await waitForContextCheck();
      assert.equal(app.input.value, '', change);
      assert.deepEqual(app.links(), [], change);
      assert.deepEqual(env.store, retained, `${change}: no invalid or foreign draft is deleted or rewritten`);
      assert.deepEqual(env.writes, [], change);
      assert.deepEqual(env.apiCalls, [], change); assert.deepEqual(env.nativeCalls, [], change);
      assert.deepEqual(env.reviews, [], change); assert.deepEqual(env.runs, [], change);
    } finally { app.panel.dispose(); }
  }
});

test('a verified empty or invalid startup lookup is consumed once and never becomes a storage polling loop', async () => {
  for (const missing of [true, false]) {
    const env = startupDraftEnvironment();
    const saved = copy(env.store);
    env.store = missing ? null : { ...saved, approvedTargets: ['candidate'] };
    const app = mount(env);
    try {
      env.usable = true;
      await waitForContextCheck();
      assert.equal(env.managerReads, 1, 'only one verified account-scoped lookup is attempted');
      env.store = saved;
      await waitForContextCheck();
      env.usable = false; await waitForContextCheck();
      env.usable = true; await waitForContextCheck();
      assert.equal(env.managerReads, 1, 'later timers or actor availability changes do not retry the consumed startup lookup');
      assert.equal(app.input.value, ''); assert.deepEqual(app.links(), []);
      assert.deepEqual(env.writes, []); assert.deepEqual(env.apiCalls, []);
      assert.deepEqual(env.nativeCalls, []); assert.deepEqual(env.reviews, []); assert.deepEqual(env.runs, []);
    } finally { app.panel.dispose(); }
  }
});

test('startup restoration never overwrites seed or delay edits even when a person clears them back to defaults', async () => {
  for (const edit of ['typed-without-event', 'typed-then-cleared', 'delay', 'delay-back-to-default']) {
    const env = startupDraftEnvironment(); const app = mount(env);
    try {
      const days = app.all().find(node => node.tagName === 'select');
      if (edit === 'typed-without-event') app.input.value = 'my_new_choice';
      if (edit === 'typed-then-cleared') {
        app.input.value = 'my_new_choice'; app.input.dispatch('input');
        app.input.value = ''; app.input.dispatch('input');
      }
      if (edit === 'delay' || edit === 'delay-back-to-default') {
        days.value = '10'; days.dispatch('change');
        if (edit === 'delay-back-to-default') { days.value = '7'; days.dispatch('change'); }
      }
      const editedInput = app.input.value, editedDays = days.value;
      env.usable = true;
      await waitForContextCheck();
      assert.equal(app.input.value, editedInput, `${edit}: the user's seed input remains authoritative`);
      assert.equal(days.value, editedDays, `${edit}: delay choice remains unchanged`);
      assert.deepEqual(app.links(), [], edit);
      assert.deepEqual(env.writes, [], edit); assert.deepEqual(env.nativeCalls, [], edit);
      assert.deepEqual(env.apiCalls, [], edit); assert.deepEqual(env.runs, [], edit);
    } finally { app.panel.dispose(); }
  }
});

test('an explicit new search while verification is unavailable closes the late restore opportunity', async () => {
  const env = startupDraftEnvironment(); const app = mount(env);
  try {
    await app.panel.findCandidates();
    env.usable = true;
    await waitForContextCheck();
    assert.equal(app.input.value, '');
    assert.deepEqual(app.links(), []);
    assert.deepEqual(env.apiCalls, []); assert.deepEqual(env.nativeCalls, []); assert.deepEqual(env.runs, []);
  } finally { app.panel.dispose(); }
});

test('a newly started API search retains its own selection and read ownership instead of restoring an older draft', async () => {
  const env = startupDraftEnvironment(); const app = mount(env);
  let finish;
  env.api = () => new Promise(resolve => { finish = resolve; });
  env.usable = true;
  app.input.value = 'seed_b';
  const pending = app.panel.findCandidates();
  try {
    assert.equal(app.panel.busy(), true);
    await waitForContextCheck();
    assert.equal(app.input.value, 'seed_b');
    assert.deepEqual(app.links(), []);
    assert.equal(app.panel.busy(), true);
    assert.equal(env.apiCalls[0].signal.aborted, false, 'late readiness cannot stop the explicit new read');
    finish(apiResult('seed_b', env.clock)); await pending;
    assert.equal(app.input.value, 'seed_b');
    assert.deepEqual(env.nativeCalls, []); assert.deepEqual(env.runs, []); assert.deepEqual(env.writes, []);
  } finally {
    if (app.panel.busy()) { finish(apiResult('seed_b', env.clock)); await pending; }
    app.panel.dispose();
  }
});

test('a new due-campaign review and busy work prevent a delayed read draft from replacing current intent', async () => {
  const busyEnv = startupDraftEnvironment(); busyEnv.externalBusy = true;
  const busyApp = mount(busyEnv);
  try {
    busyEnv.usable = true; await waitForContextCheck();
    busyEnv.externalBusy = false; await waitForContextCheck();
    assert.equal(busyApp.input.value, ''); assert.deepEqual(busyApp.links(), []);
    assert.deepEqual(busyEnv.apiCalls, []); assert.deepEqual(busyEnv.nativeCalls, []); assert.deepEqual(busyEnv.runs, []);
  } finally { busyApp.panel.dispose(); }

  const env = startupDraftEnvironment(); env.campaigns = [dueCampaign(env.clock)];
  const app = mount(env); let finish;
  env.approval = () => new Promise(resolve => { finish = resolve; });
  env.usable = true;
  const pending = app.panel.reviewDue();
  try {
    assert.equal(env.reviews.length, 1, 'the person began a separate valid campaign review');
    await waitForContextCheck();
    assert.equal(app.input.value, ''); assert.deepEqual(app.links(), []);
    finish(null); await pending;
    assert.deepEqual(env.runs, []); assert.deepEqual(env.nativeCalls, []); assert.deepEqual(env.writes, []);
  } finally { finish?.(null); await pending; app.panel.dispose(); }
});

test('intervening busy work cancels pending restoration before the unavailable actor verifies', async () => {
  const env = startupDraftEnvironment();
  const original = copy(env.store);
  const app = mount(env);
  try {
    assert.equal(env.externalBusy, undefined);
    assert.equal(env.usable, false);
    assert.equal(env.managerReads, 0);
    env.externalBusy = true;
    await waitForContextCheck();
    assert.equal(env.managerReads, 0, 'busy work while unverified does not read account-scoped storage');
    env.externalBusy = false;
    await waitForContextCheck();
    env.usable = true;
    await waitForContextCheck();
    assert.equal(env.managerReads, 0, 'observed intervening work consumes restoration before any verified storage lookup');
    assert.deepEqual(env.readStorageContexts, [], 'the pending guard never polls stored drafts');
    assert.equal(app.input.value, '');
    assert.deepEqual(app.links(), []);
    assert.deepEqual(env.store, original);
    assert.deepEqual(env.writes, []); assert.deepEqual(env.apiCalls, []); assert.deepEqual(env.nativeCalls, []);
    assert.deepEqual(env.reviews, []); assert.deepEqual(env.runs, []); assert.deepEqual(env.campaigns, []);
  } finally { app.panel.dispose(); }
});

for (const seedCount of [1, 2, 3]) {
  test(`native Growth reads ${seedCount} selected seeds across reloads and keeps Follow separately reviewed`, async () => {
    const env = environment(seedCount);
    let app = await startDraft(env);
    assert.deepEqual(env.apiCalls.map(call => call.username), ['seed_a']);
    assert.deepEqual(app.links(), env.seeds.map(seed => `https://www.instagram.com/${seed}/`));
    assert.equal(env.store.kind, 'growth-read-draft');
    assert.equal(JSON.stringify(env.store).includes('capability'), false);
    assert.deepEqual(env.campaigns, []); assert.deepEqual(env.runs, []);
    for (const [index, seed] of env.seeds.entries()) {
      app.panel.dispose(); env.profile = seed; app = mount(env);
      assert.equal(env.nativeCalls.length, index, 'reload never reads a list automatically');
      assert.equal(app.input.value.replace(/\s/g, ''), env.seeds.join(','));
      await app.panel.readCurrentSeed();
      assert.deepEqual(env.nativeCalls.map(call => call.username), env.seeds.slice(0, index + 1));
      const result = env.store.results[seed];
      assert.equal(result.source, 'list-dialog');
      for (const type of ['followers', 'following']) {
        assert.equal(result.lists[type].owner, seed); assert.equal(result.lists[type].listType, type);
        assert.equal(result.lists[type].source, 'list-dialog'); assert.equal(result.lists[type].verified, true);
        assert.equal(result.lists[type].capturedAt, iso(env.clock));
        assert.equal(result.lists[type].accounts[0].source, 'extension-scrolled-dom');
        assert.equal('instagramId' in result.lists[type].accounts[0], false);
      }
      if (index < seedCount - 1) {
        await app.panel.reviewFollow();
        assert.equal(env.reviews.length, 0, 'unfinished seed reads cannot reach action review');
      }
      assert.equal(env.runs.length, 0);
    }
    app.panel.dispose(); app = mount(env);
    assert.equal(env.runs.length, 0, 'completed read draft is not action authority after reload');
    await app.panel.reviewFollow();
    assert.equal(env.runs.length, 0, 'Cancel never creates a Follow run');
    assert.deepEqual(env.campaigns, []);
    env.approval = true; await app.panel.reviewFollow();
    assert.equal(env.runs.length, 1); assert.deepEqual(env.runs[0].usernames, ['candidate']);
    assert.equal(env.runs[0].action, 'follow'); assert.equal(env.runs[0].growthAccount, 'owner');
    assert.equal(env.runs[0].expiresAt, env.reviews.at(-1).binding.expiresAt);
    app.panel.dispose();
  });
}

test('API seed observations remain truthful when later retired lookups need explicit native reads', async () => {
  const env = environment(2);
  env.api = async username => { if (username === 'seed_a') return apiResult(username, env.clock); throw retired(410); };
  let app = await startDraft(env);
  assert.equal(env.store.results.seed_a.source, 'authenticated-instagram-web');
  assert.equal(env.store.results.seed_a.lists.following.accounts[0].source, 'authenticated-instagram-web');
  app.panel.dispose(); env.profile = 'seed_b'; app = mount(env);
  await app.panel.readCurrentSeed();
  assert.deepEqual(env.nativeCalls.map(call => call.username), ['seed_b']);
  assert.equal(env.store.results.seed_a.source, 'authenticated-instagram-web');
  assert.equal(env.store.results.seed_b.source, 'list-dialog');
  env.approval = true; await app.panel.reviewFollow();
  assert.deepEqual(env.runs[0].usernames, ['candidate']); app.panel.dispose();
});

test('native seed reads restore C then A then B even when serialized result keys differ from selection order', async () => {
  const env = environment(3); let app = await startDraft(env);
  for (const seed of ['seed_c', 'seed_a', 'seed_b']) {
    app.panel.dispose(); env.profile = seed; app = mount(env);
    assert.deepEqual(app.links(), env.seeds.map(name => `https://www.instagram.com/${name}/`));
    await app.panel.readCurrentSeed();
    assert.ok(env.store.results[seed], `${seed} retained`);
    if (seed === 'seed_a') {
      // Storage preserves object insertion order; it does not establish list ownership or selection order.
      env.store.results = { seed_c: env.store.results.seed_c, seed_a: env.store.results.seed_a };
      assert.deepEqual(Object.keys(env.store.results), ['seed_c', 'seed_a']);
    }
  }
  app.panel.dispose(); app = mount(env);
  assert.deepEqual(env.nativeCalls.map(call => call.username), ['seed_c', 'seed_a', 'seed_b']);
  assert.deepEqual(Object.keys(env.store.results).sort(), env.seeds);
  env.approval = true; await app.panel.reviewFollow();
  assert.deepEqual(env.runs[0].usernames, ['candidate']); app.panel.dispose();
});

test('a fresh modal actor proof sustains only the active native read and contextual storage access', async () => {
  const env = environment(); const app = await startDraft(env); env.profile = 'seed_a';
  let finish;
  env.inspectRead = ({ actor, seed }) => env.modal?.visible && env.modal.actor === actor
    && env.modal.seed === seed && env.profile === seed
    ? { accountVerified: true, usable: true, accountId: actor }
    : null;
  env.native = (_username, _signal, onProgress) => new Promise(resolve => {
    finish = resolve; env.usable = false; env.modal = { visible: true, actor: 'owner', seed: 'seed_a' };
    onProgress({ phase: 'native-reading', listType: 'followers', found: 1 });
    onProgress({ phase: 'native-reading', listType: 'following', found: 1 });
  });
  const pending = app.panel.readCurrentSeed(); await settleStarted(env);
  assert.ok(env.readAccountCalls.length >= 2, 'every modal checkpoint requests fresh actor proof');
  assert.ok(env.readAccountCalls.every(context => context.actor === 'owner' && context.seed === 'seed_a'));
  assert.ok(env.readStorageContexts.some(context => context.actor === 'owner' && context.seed === 'seed_a'),
    'storage reads receive the exact active actor and seed');
  env.usable = true; env.modal = null; finish(nativeResult('seed_a', env.clock)); await pending;
  assert.ok(env.store.results.seed_a); assert.deepEqual(env.runs, []);
  assert.ok(env.writeStorageContexts.some(context => context.actor === 'owner' && context.seed === 'seed_a'),
    'seed result writes retain exact contextual ownership');
  env.usable = false; env.modal = { visible: true, actor: 'owner', seed: 'seed_a' };
  const proofCallsBeforeReview = env.readAccountCalls.length;
  env.approval = true; await app.panel.reviewFollow();
  assert.equal(env.readAccountCalls.length, proofCallsBeforeReview, 'modal proof cannot authorize outside an active read');
  assert.deepEqual(env.runs, []); assert.deepEqual(env.campaigns, []); app.panel.dispose();
});

test('modal actor authority is fresh and aborts when proof disappears, changes owner, hides or changes seed', async () => {
  for (const invalidation of ['missing', 'wrong-owner', 'hidden', 'wrong-seed']) {
    const env = environment(); const app = await startDraft(env); env.profile = 'seed_a';
    let finish;
    env.modal = { visible: true, actor: 'owner', seed: 'seed_a' };
    env.inspectRead = ({ actor, seed }) => {
      if (env.modal?.returnWrongActor) return { accountVerified: true, usable: true, accountId: 'another_owner' };
      return env.modal?.visible && env.modal.actor === actor && env.modal.seed === seed && env.profile === seed
        ? { accountVerified: true, usable: true, accountId: actor } : null;
    };
    env.native = (_username, _signal, onProgress) => new Promise(resolve => {
      finish = resolve; env.usable = false;
      onProgress({ phase: 'native-reading', listType: 'followers', found: 1 });
    });
    const pending = app.panel.readCurrentSeed(); await settleStarted(env);
    const checkedBefore = env.readAccountCalls.length;
    if (invalidation === 'missing') env.modal = null;
    if (invalidation === 'wrong-owner') env.modal.returnWrongActor = true;
    if (invalidation === 'hidden') env.modal.visible = false;
    if (invalidation === 'wrong-seed') env.modal.seed = 'seed_b';
    assert.throws(() => env.nativeCalls[0].onProgress({ phase: 'native-reading', listType: 'following', found: 1 }),
      /stopped|changed/i, invalidation);
    assert.ok(env.readAccountCalls.length > checkedBefore, `${invalidation}: cached actor was not reused`);
    assert.equal(env.nativeCalls[0].signal.aborted, true, invalidation);
    env.usable = true; env.modal = null; finish(nativeResult('seed_a', env.clock)); await pending;
    assert.equal(env.store.results.seed_a, undefined, invalidation);
    assert.deepEqual(env.runs, [], invalidation); app.panel.dispose();
  }
});

test('an inactive modal proof cannot start native reads when ordinary actor verification is unavailable', async () => {
  const env = environment(); const app = await startDraft(env); env.profile = 'seed_a'; env.usable = false;
  env.inspectRead = () => ({ accountVerified: true, usable: true, accountId: 'owner' });
  await app.panel.readCurrentSeed();
  assert.deepEqual(env.nativeCalls, []); assert.deepEqual(env.readAccountCalls, []);
  assert.deepEqual(env.runs, []); app.panel.dispose();
});

test('normal route changes update the current-seed control without remounting or starting a read', async () => {
  const env = environment(2); const app = await startDraft(env);
  const readButton = app.all().find(node => node.tagName === 'button' && node.textContent === 'Read current seed');
  assert.equal(readButton.disabled, true, 'own profile has no seed read');
  env.profile = 'seed_b';
  await waitUntil(() => readButton.disabled === false, 'selected route enables its explicit read control');
  assert.deepEqual(env.nativeCalls, []); assert.equal(env.apiCalls.length, 1);
  env.profile = 'unselected';
  await waitUntil(() => readButton.disabled === true, 'unselected route disables the read control');
  env.profile = 'seed_a';
  await waitUntil(() => readButton.disabled === false, 'another selected route enables the same mounted control');
  assert.deepEqual(env.nativeCalls, []); assert.deepEqual(env.runs, []); app.panel.dispose();
});

test('Growth keeps the default API discovery path when exact lookup data remains available', async () => {
  const env = environment(3); env.api = async username => apiResult(username, env.clock);
  const app = mount(env); app.input.value = env.seeds.join(',');
  await app.panel.findCandidates();
  assert.deepEqual(env.apiCalls.map(call => call.username), env.seeds);
  assert.deepEqual(env.nativeCalls, []); assert.equal(env.store, null);
  env.approval = true; await app.panel.reviewFollow();
  assert.deepEqual(env.runs[0].usernames, ['candidate']); app.panel.dispose();
});

test('authentication, throttling, parse, identity and abort failures never start native discovery', async () => {
  for (const error of [
    Object.assign(new Error('forbidden'), { code: 'request-failed', httpStatus: 403 }),
    Object.assign(new Error('rate limited'), { code: 'rate-limited', httpStatus: 429 }),
    Object.assign(new Error('challenge'), { code: 'challenge' }),
    Object.assign(new Error('invalid data'), { code: 'invalid-response' }),
    Object.assign(new Error('wrong account'), { code: 'profile-mismatch' }),
    Object.assign(new Error('stopped'), { code: 'stopped' }),
    Object.assign(new Error('contradictory retirement marker'), { code: 'request-failed', httpStatus: 403, lookupRoutesRetired: true }),
  ]) {
    const env = environment(); env.api = async () => { throw error; };
    const app = mount(env); app.input.value = 'seed_a'; await app.panel.findCandidates();
    assert.equal(env.store, null, error.message); assert.deepEqual(env.nativeCalls, [], error.message);
    await app.panel.reviewFollow(); assert.deepEqual(env.runs, [], error.message); app.panel.dispose();
  }
});

test('only the selected current seed and unchanged actor Following snapshot can start an explicit read', async () => {
  for (const drift of ['profile', 'selection', 'actor', 'following', 'expired']) {
    const env = environment(2); const app = await startDraft(env); env.profile = 'seed_a';
    if (drift === 'profile') env.profile = 'unselected';
    if (drift === 'selection') app.input.value = 'seed_b';
    if (drift === 'actor') env.actor = 'another_owner';
    if (drift === 'following') env.followingSnapshot.accounts.push(nativeRow('new_follow'));
    if (drift === 'expired') env.clock += 31 * 60_000;
    await app.panel.readCurrentSeed();
    assert.equal(env.nativeCalls.length, 0, drift); assert.deepEqual(env.runs, [], drift); app.panel.dispose();
  }
});

test('late native results cannot apply after actor, Following, selection, profile or expiry changes', async () => {
  for (const drift of ['profile', 'selection', 'actor', 'following', 'expired']) {
    const env = environment(2); const app = await startDraft(env); env.profile = 'seed_a';
    let finish; env.native = () => new Promise(resolve => { finish = resolve; });
    const pending = app.panel.readCurrentSeed(); await settleStarted(env);
    if (drift === 'profile') env.profile = 'seed_b';
    if (drift === 'selection') app.input.value = 'seed_b';
    if (drift === 'actor') env.actor = 'another_owner';
    if (drift === 'following') env.followingSnapshot.accounts.push(nativeRow('new_follow'));
    if (drift === 'expired') env.clock += 31 * 60_000;
    assert.throws(() => env.nativeCalls[0].onProgress({ phase: 'native-reading', listType: 'followers', found: 1 }),
      /stopped|changed/i, `${drift}: progress refuses stale context before another native step`);
    finish(nativeResult('seed_a', env.clock)); await pending;
    assert.equal(Boolean(env.store?.results?.seed_a && !env.store.results.seed_a.partial), false, drift);
    assert.equal(env.nativeCalls[0].signal.aborted, true, `${drift}: stale context aborts further reads`);
    await app.panel.reviewFollow(); assert.deepEqual(env.runs, [], drift); app.panel.dispose();
  }
});

test('Stop aborts the active read and retains explicit partial provenance without Follow authority', async () => {
  const env = environment(); let app = await startDraft(env); env.profile = 'seed_a';
  env.native = (_username, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
    reject(Object.assign(new Error('stopped'), { code: 'stopped', partialResult: nativeResult('seed_a', env.clock, {
      following: [], verified: { followers: true, following: false },
      complete: { followers: true, following: false }, expectedCounts: { followers: 1, following: 1 },
      reasons: { followers: 'native-list-complete', following: 'stopped' },
    }) }));
  }, { once: true }));
  const pending = app.panel.readCurrentSeed(); await settleStarted(env);
  app.panel.stopSearch(); await pending;
  assert.equal(env.nativeCalls[0].signal.aborted, true); assert.equal(env.store.status, 'stopped');
  assert.equal(env.store.results.seed_a.partial, true);
  assert.equal(env.store.results.seed_a.lists.followers.verified, true);
  assert.equal(env.store.results.seed_a.lists.following.verified, false);
  assert.equal(env.store.results.seed_a.lists.followers.accounts[0].username, 'candidate');
  await app.panel.reviewFollow(); assert.deepEqual(env.runs, []); assert.deepEqual(env.campaigns, []);
  app.panel.dispose(); app = mount(env); assert.equal(env.nativeCalls.length, 1, 'reload preserves Stop');
  env.native = async username => nativeResult(username, env.clock);
  await app.panel.readCurrentSeed(); assert.equal(env.nativeCalls.length, 2, 'fresh explicit read can continue');
  assert.equal(env.store.results.seed_a.partial, false); assert.deepEqual(env.runs, []); app.panel.dispose();
});

test('partial but verified seed samples produce only positive observed mutuals and disclose missing coverage', async () => {
  const env = environment(); const app = await startDraft(env); env.profile = 'seed_a';
  env.native = async username => nativeResult(username, env.clock, {
    complete: { followers: false, following: false }, expectedCounts: { followers: 10, following: 11 },
    reasons: { followers: 'count-mismatch', following: 'native-list-truncated' },
  });
  await app.panel.readCurrentSeed();
  assert.match(app.text(), /partial|missing/i); env.approval = true; await app.panel.reviewFollow();
  assert.deepEqual(env.runs[0].usernames, ['candidate']); app.panel.dispose();
});

test('storage failure, forged drafts and concurrent draft replacement cannot become native/action authority', async () => {
  const unavailable = environment(); unavailable.failWrites = true;
  const unavailableApp = mount(unavailable); unavailableApp.input.value = 'seed_a';
  await assert.rejects(unavailableApp.panel.findCandidates(), /fixture-storage-write-failed/);
  unavailable.profile = 'seed_a'; await unavailableApp.panel.readCurrentSeed();
  assert.equal(unavailable.store, null); assert.deepEqual(unavailable.nativeCalls, []); assert.deepEqual(unavailable.runs, []);
  unavailableApp.panel.dispose();

  const forged = environment(); let forgedApp = await startDraft(forged); forgedApp.panel.dispose();
  forged.store = { ...forged.store, approvedTargets: ['candidate'], capabilityExpiresAt: forged.clock + 60_000 };
  forged.profile = 'seed_a'; forgedApp = mount(forged); await forgedApp.panel.readCurrentSeed();
  await forgedApp.panel.reviewFollow(); assert.deepEqual(forged.nativeCalls, []); assert.deepEqual(forged.runs, []); forgedApp.panel.dispose();

  const concurrent = environment(); const concurrentApp = await startDraft(concurrent); concurrent.profile = 'seed_a';
  let finish; concurrent.native = () => new Promise(resolve => { finish = resolve; });
  const pending = concurrentApp.panel.readCurrentSeed(); await settleStarted(concurrent);
  const replacement = createGrowthReadDraft({ actor: 'owner', followingSnapshot: concurrent.followingSnapshot,
    seeds: ['seed_a'], now: concurrent.clock, id: 'newer-draft' });
  concurrent.store = copy(replacement); finish(nativeResult('seed_a', concurrent.clock)); await pending;
  assert.deepEqual(concurrent.store, copy(replacement), 'a late reader never overwrites a different stored draft');
  assert.deepEqual(concurrent.runs, []); concurrentApp.panel.dispose();
});

test('Follow rechecks draft context after confirmation instead of treating a completed read as approval', async () => {
  for (const drift of ['actor', 'following', 'selection', 'expiry']) {
    const env = environment(); const app = await startDraft(env); env.profile = 'seed_a'; await app.panel.readCurrentSeed();
    env.approval = ({ binding }) => {
      if (drift === 'actor') env.actor = 'another_owner';
      if (drift === 'following') env.followingSnapshot.accounts.push(nativeRow('new_follow'));
      if (drift === 'selection') app.input.value = 'other';
      if (drift === 'expiry') env.clock += 31 * 60_000;
      return binding;
    };
    await app.panel.reviewFollow(); assert.deepEqual(env.runs, [], drift); assert.deepEqual(env.campaigns, [], drift); app.panel.dispose();
  }
});

function dueCampaign(clock) {
  const followedAt = clock - 8 * 86_400_000;
  return { schemaVersion: 1, id: 'existing-due-campaign', account: 'owner', createdAt: followedAt,
    delayDays: 7, targets: ['campaign_target'], followed: { campaign_target: followedAt }, unfollowed: {} };
}

test('the panel native-read controller blocks due campaign review even when external busy is false', async () => {
  const env = environment(); env.campaigns = [dueCampaign(env.clock)];
  const app = await startDraft(env); env.profile = 'seed_a';
  let finishRead; env.native = () => new Promise(resolve => { finishRead = resolve; });
  const pendingRead = app.panel.readCurrentSeed(); await settleStarted(env);
  assert.equal(app.panel.busy(), true, 'the panel owns an active native read');
  env.approval = true;
  await app.panel.reviewDue();
  assert.deepEqual(env.reviews, [], 'an internal read prevents opening an Unfollow confirmation');
  assert.deepEqual(env.runs, []);
  finishRead(nativeResult('seed_a', env.clock)); await pendingRead;
  await app.panel.reviewDue();
  assert.equal(env.reviews.length, 1, 'the same independently valid due campaign can be freshly reviewed afterward');
  assert.deepEqual(env.runs.map(run => [run.action, run.usernames]), [['unfollow', ['campaign_target']]]);
  app.panel.dispose();
});

test('an earlier due approval cannot dispatch if a native seed read starts while confirmation is open', async () => {
  const env = environment(); env.campaigns = [dueCampaign(env.clock)];
  const app = await startDraft(env); env.profile = 'seed_a';
  let finishApproval;
  env.approval = ({ binding }) => new Promise(resolve => { finishApproval = () => resolve(binding); });
  const pendingDue = app.panel.reviewDue();
  assert.equal(env.reviews.length, 1, 'a valid due review was opened before the read');
  let finishRead; env.native = () => new Promise(resolve => { finishRead = resolve; });
  const pendingRead = app.panel.readCurrentSeed(); await settleStarted(env);
  finishApproval(); await pendingDue;
  assert.deepEqual(env.runs, [], 'resolving prior approval during a native read grants no action authority');
  finishRead(nativeResult('seed_a', env.clock)); await pendingRead;
  assert.deepEqual(env.runs, [], 'finishing the read never replays the earlier approval');
  env.approval = true; await app.panel.reviewDue();
  assert.equal(env.reviews.length, 2, 'a separate fresh review is required');
  assert.deepEqual(env.runs.map(run => [run.action, run.usernames]), [['unfollow', ['campaign_target']]]);
  app.panel.dispose();
});

test('read controls recover after fresh actor proof returns and hide when the saved read expires', async () => {
  const env = environment(); const app = await startDraft(env); env.profile = 'seed_a';
  const readButton = app.all().find(node => node.tagName === 'button' && node.textContent === 'Read current seed');
  const steps = readButton.parentElement;
  await waitUntil(() => !steps.hidden && !readButton.disabled, 'selected seed starts available for an explicit read');
  env.usable = false;
  await waitUntil(() => steps.hidden, 'unavailable ordinary actor proof hides the read controls');
  env.usable = true;
  await waitUntil(() => !steps.hidden && !readButton.disabled, 'fresh actor proof restores the same mounted controls');
  env.clock += 31 * 60_000;
  await waitUntil(() => steps.hidden, 'expiry hides stale read controls without a route change');
  assert.deepEqual(env.nativeCalls, []); assert.deepEqual(env.runs, []); assert.equal(env.apiCalls.length, 1);
  app.panel.dispose();
});
