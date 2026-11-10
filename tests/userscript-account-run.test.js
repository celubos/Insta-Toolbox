import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../userscripts/src/toolbox-shell.js', import.meta.url), 'utf8');
const section = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
const digest = section('  function accountCapabilityDigest(', '  function visibleText(');
const normalize = section('  function normalizeResumableAccountRun(', '  function readManagerTab(');
const valid = section('  function runCapabilityValid(', '  function stopForExpiredCapability(');
const runner = section('  async function runOneAccount(', '  // --- Section 2:');
const stop = section("    'stop-run':", "    'scan-list':");
const viewerSource = await readFile(new URL('../extension/instagram-viewer.js', import.meta.url), 'utf8');

function lockManager() {
  const held = new Set();
  const requests = [];
  return { held, requests, async request(name, options, callback) {
    assert.deepEqual(JSON.parse(JSON.stringify(options)), { mode: 'exclusive', ifAvailable: true });
    requests.push(name);
    if (held.has(name)) return callback(null);
    held.add(name);
    try { return await callback({ name, mode: 'exclusive' }); }
    finally { held.delete(name); }
  } };
}

function fixture({ targets = ['candidate'], account = 'owner', growth = true, locks = lockManager() } = {}) {
  let clock = Date.now();
  const events = [], records = [], messages = [], tabWrites = [];
  const context = vm.createContext({
    AbortController, Math, Number, String, Boolean, Object, Array, Set,
    Date: class extends Date { static now() { return clock; } },
    RUN_CAPABILITY_MS: 1_200_000,
    normalizeUsername: value => String(value || '').trim().toLowerCase(),
    safeText: value => String(value || ''),
    state: { run: null },
    engine: {
      normalizeUsername: path => String(path).replaceAll('/', ''),
      detectAuthenticatedUsername: () => account,
      inspectProfile: username => ({ username, relationship: 'not-following', resolutionToken: 'exact-control' }),
      performReviewedProfileAction: async (_item, runtime) => {
        assert.ok(runtime?.assertAuthorized(), 'each dispatch requires current approval');
        assert.ok(runtime.assertContext(), 'each dispatch requires the reviewed account');
        events.push('mutation');
        return { result: 'followed', dispatched: true };
      },
    },
    location: { pathname: '/candidate/', href: 'https://www.instagram.com/candidate/' },
    setRun(patch) { context.state.run = { ...context.state.run, ...patch }; },
    status: message => messages.push(message),
    recordAction: () => records.push('ledger'),
    recordVerifiedGrowthAction: (_run, username) => records.push(username),
    sessionStop: () => null,
    stopForExpiredCapability() { context.setRun({ status: 'stopped', stopReason: 'expired', queue: [] }); },
    growthRunStillApproved: () => true,
    limits: () => ({ minDelayMs: 1000, maxDelayMs: 1000 }),
    REST_EVERY: 20, REST_MS: 90_000,
    sleep: async ms => { events.push(['wait', ms]); clock += ms; },
    managerTabStorageAvailable: true,
    managerTab: { instaToolboxAccountRunV1: { status: 'running' }, unrelatedTabData: 'preserved' },
    TAB_RUN_FIELD: 'instaToolboxAccountRunV1',
    GM_saveTab: value => tabWrites.push(JSON.parse(JSON.stringify(value))),
    readManagerTab: async () => tabWrites.at(-1) || null,
    renderAll: () => {},
    navigator: { locks },
    presenceSession: null, dmRunner: null, stopDmCleanup: () => false,
    crypto: { randomUUID: () => 'new-approval' },
    InstaToolboxPresenceGrowth: { growthOutcomeVerified: (_action, reason) => reason === 'followed' },
  });
  vm.runInContext(viewerSource, context);
  vm.runInContext(`let batchAbort = false; let accountActionController = null;
    ${digest}${normalize}${valid}${runner}
    const actions = { ${stop} };
    globalThis.stopAccountRun = actions['stop-run'];`, context);
  context.state.run = {
    status: 'running', kind: 'account', action: 'follow', accountUsername: 'owner',
    capabilityId: 'review-1', capabilityExpiresAt: clock + 60_000,
    approvedTargets: [...targets], queue: [...targets], total: targets.length,
    capabilityDigest: context.accountCapabilityDigest('follow', targets),
    completed: 0, skipped: 0, failed: 0, uncertain: 0, results: [],
    growthCampaignId: growth ? 'campaign-1' : '', growthAccount: growth ? 'owner' : '',
  };
  return { context, events, records, messages, locks, tabWrites,
    setAccount: value => { account = value; },
    setClock: value => { clock = value; },
    run: () => context.state.run,
  };
}

test('Stop while an Unfollow menu is opening revokes confirmation before mutation', async () => {
  const f = fixture();
  f.run().action = 'unfollow';
  f.run().capabilityDigest = f.context.accountCapabilityDigest('unfollow', ['candidate']);
  f.context.engine.inspectProfile = username => ({ username, relationship: 'following', resolutionToken: 'exact-control' });
  let opened, settle;
  const ready = new Promise(resolve => { opened = resolve; });
  const gate = new Promise(resolve => { settle = resolve; });
  f.context.engine.performReviewedProfileAction = async (_item, runtime) => {
    opened(); await gate;
    assert.equal(runtime.signal.aborted, true);
    assert.equal(runtime.assertAuthorized(), false);
    return { unexpectedUi: true, dispatched: false, reason: 'profile-action-cancelled' };
  };
  const pending = f.context.continueAccountRun();
  await ready; f.context.stopAccountRun(); settle(); await pending;
  assert.equal(f.run().status, 'aborted');
  assert.deepEqual(f.events, []);
  assert.deepEqual(f.records, []);
});

test('a dispatched action verified after Stop is recorded once without restarting the queue', async () => {
  const f = fixture({ targets: ['candidate', 'next'] });
  f.context.engine.performReviewedProfileAction = async (_item, runtime) => {
    f.events.push('mutation'); f.context.stopAccountRun();
    assert.equal(runtime.signal.aborted, true);
    return { result: 'followed', dispatched: true, needsAttention: true };
  };
  await f.context.continueAccountRun();
  assert.equal(f.run().status, 'aborted');
  assert.equal(f.run().completed, 1);
  assert.equal(f.run().queue.length, 0);
  assert.deepEqual(f.records, ['ledger', 'candidate']);
  assert.deepEqual(f.events, ['mutation']);
});

test('an unproven dispatched action remains unconfirmed and stops before another target', async () => {
  const f = fixture({ targets: ['candidate', 'next'] });
  f.context.engine.performReviewedProfileAction = async () => ({ uncertain: true, dispatched: true });
  await f.context.continueAccountRun();
  assert.equal(f.run().status, 'stopped');
  assert.equal(f.run().uncertain, 1);
  assert.equal(f.run().failed, 0);
  assert.equal(f.run().completed, 0);
  assert.equal(f.run().queue.length, 0);
  assert.match(f.run().results[0].reason, /could not be verified/);
});

test('the profile engine cannot confirm after the signed-in account changes', async () => {
  const f = fixture();
  f.context.engine.performReviewedProfileAction = async (_item, runtime) => {
    assert.equal(runtime.assertContext(), true);
    f.setAccount('another.owner');
    assert.equal(runtime.assertContext(), false);
    return { unexpectedUi: true, reason: 'profile-context-changed' };
  };
  await f.context.continueAccountRun();
  assert.deepEqual(f.records, []);
});

test('a reviewed growth campaign retains its remaining target across profile navigation', async () => {
  const first = fixture({ targets: ['candidate', 'next'] });
  await first.context.resumeApprovedAccountRun();
  assert.equal(first.run().completed, 1);
  assert.equal(first.context.location.href, 'https://www.instagram.com/next/');
  assert.equal(first.run().queue.join(','), 'next');
  assert.deepEqual(first.events, ['mutation', ['wait', 1000]]);
  const arrived = fixture();
  arrived.context.state.run = arrived.context.normalizeResumableAccountRun(JSON.parse(JSON.stringify(first.run())));
  arrived.context.location.pathname = '/next/';
  await arrived.context.resumeApprovedAccountRun();
  assert.equal(arrived.run().status, 'completed');
  assert.equal(arrived.run().completed, 2);
  assert.deepEqual(arrived.records, ['ledger', 'next']);
});

test('unbound legacy queues are not restored or silently resumed', async () => {
  const f = fixture({ growth: false });
  await f.context.resumeApprovedAccountRun();
  assert.equal(f.run().status, 'stopped');
  assert.equal(f.run().stopReason, 'legacy account run retired');
  assert.deepEqual(f.events, []);
  assert.equal(f.context.normalizeResumableAccountRun({ ...f.run(), status: 'running', queue: ['candidate'], accountUsername: '' }), null);
});

test('expiry or an account change stops a navigated campaign before any click', async () => {
  for (const change of ['expired', 'account']) {
    const f = fixture();
    if (change === 'expired') f.setClock(f.run().capabilityExpiresAt + 1);
    else f.setAccount('another.owner');
    await f.context.resumeApprovedAccountRun();
    assert.equal(f.run().status, 'stopped');
    assert.deepEqual(f.events, []);
  }
});

test('a new run cannot replace a stopped action whose result is still settling', async () => {
  const f = fixture();
  let started, settle;
  const ready = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { settle = resolve; });
  f.context.engine.performReviewedProfileAction = async () => { started(); await gate; return { result: 'followed' }; };
  const pending = f.context.continueAccountRun(); await ready;
  f.context.stopAccountRun();
  await f.context.startAccountRun({ action: 'follow', usernames: ['next'] });
  assert.equal(f.run().capabilityId, 'review-1');
  assert.match(f.messages.at(-1), /still being checked/);
  settle(); await pending;
  assert.equal(f.run().completed, 1);
});

test('campaign start preserves the original review deadline across profile navigation', async () => {
  const f = fixture();
  f.context.state.run = null;
  f.context.location.pathname = '/another.profile/';
  const expiresAt = Date.now() + 5000;
  await f.context.startAccountRun({ action: 'follow', usernames: ['candidate'],
    growthCampaignId: 'campaign-1', growthAccount: 'owner', expiresAt });
  assert.equal(f.run().capabilityExpiresAt, expiresAt);
  assert.equal(f.context.location.href, 'https://www.instagram.com/candidate/');
  assert.equal(f.context.normalizeResumableAccountRun(f.run()).capabilityExpiresAt, expiresAt);
});

test('a campaign missing its reviewed deadline cannot mint a fresh approval', async () => {
  for (const expiresAt of [undefined, 0, NaN, Infinity, Date.now() - 1000]) {
    const f = fixture(); f.context.state.run = null;
    await f.context.startAccountRun({ action: 'follow', usernames: ['candidate'],
      growthCampaignId: 'campaign-1', growthAccount: 'owner', expiresAt });
    assert.equal(f.run(), null);
    assert.deepEqual(f.events, []);
  }
});

test('restored campaign and reviewed account identities must agree', async () => {
  const f = fixture(); f.run().growthAccount = 'another.owner';
  assert.equal(f.context.normalizeResumableAccountRun(f.run()), null);
  await f.context.resumeApprovedAccountRun();
  assert.equal(f.run().status, 'stopped');
  assert.deepEqual(f.events, []);
});

test('a growth profile action uses the exact account lane shared by Presence and Ghost', async () => {
  const f = fixture();
  const key = f.context.InstaToolboxInstagramViewer.accountKey('owner');
  const lane = `insta-toolbox:account-activity:${key}`;
  f.locks.held.add(lane);
  await f.context.continueAccountRun();
  assert.deepEqual(f.locks.requests, [lane]);
  assert.deepEqual(f.events, []);
  assert.equal(f.run().status, 'stopped');
  assert.match(f.run().stopReason, /Another Presence, Ghost Mode/);
});

test('growth account coordination fails closed when Web Locks are unavailable or reject', async () => {
  for (const locks of [null, { request: async () => { throw new Error('browser-lock-unavailable'); } }]) {
    const f = fixture({ locks });
    await f.context.continueAccountRun();
    assert.equal(f.run().status, 'stopped');
    assert.equal(f.run().completed, 0);
    assert.deepEqual(f.events, []);
    assert.match(f.run().stopReason, /coordinate account actions/);
  }
});

test('the growth account lane stays held through a stopped action settlement and prevents another tab', async () => {
  const locks = lockManager();
  const first = fixture({ locks }), second = fixture({ locks });
  let started, settle;
  const ready = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { settle = resolve; });
  first.context.engine.performReviewedProfileAction = async () => { started(); await gate; return { result: 'followed' }; };
  const pending = first.context.continueAccountRun();
  await ready;
  first.context.stopAccountRun();
  assert.equal(locks.held.size, 1);
  await second.context.continueAccountRun();
  assert.equal(second.run().status, 'stopped');
  assert.deepEqual(second.events, []);
  settle(); await pending;
  assert.equal(first.run().completed, 1);
  assert.equal(locks.held.size, 0);
});

test('a verified native result survives ledger failure and stops before the next target', async () => {
  const f = fixture({ targets: ['candidate', 'next'] });
  f.context.recordAction = () => { throw new Error('storage-unavailable'); };
  await f.context.continueAccountRun();
  assert.equal(f.run().completed, 1);
  assert.equal(f.run().failed, 0);
  assert.equal(f.run().status, 'stopped');
  assert.equal(f.run().queue.length, 0);
  assert.equal(f.run().results[0].status, 'completed');
  assert.match(f.run().stopReason, /verified.*could not be saved/);
  assert.deepEqual(f.events, ['mutation']);
  assert.deepEqual(f.records, ['candidate']);
  assert.equal(f.tabWrites.at(-1).instaToolboxAccountRunV1, undefined,
    'the outcome commit also revokes resume, with no saved running gap');
});

test('an unexpected native engine rejection stays uncertain and cannot continue to another target', async () => {
  const f = fixture({ targets: ['candidate', 'next'] });
  f.context.engine.performReviewedProfileAction = async () => { f.events.push('mutation'); throw new Error('lost-acknowledgment'); };
  await f.context.continueAccountRun();
  assert.equal(f.run().status, 'stopped');
  assert.equal(f.run().completed, 0);
  assert.equal(f.run().uncertain, 1);
  assert.equal(f.run().failed, 0);
  assert.equal(f.run().queue.length, 0);
  assert.deepEqual(f.events, ['mutation']);
  assert.equal(f.locks.held.size, 0);
});

test('failure saving the final result keeps proof in memory and independently invalidates private resume state', async () => {
  const f = fixture({ targets: ['candidate', 'next'] });
  const update = f.context.setRun;
  f.context.setRun = patch => {
    update(patch);
    if (patch.results) throw new Error('result-storage-unavailable');
  };
  await f.context.continueAccountRun();
  assert.equal(f.run().completed, 1);
  assert.equal(f.run().results[0].status, 'completed');
  assert.equal(f.run().status, 'stopped');
  assert.equal(f.run().queue.length, 0);
  assert.deepEqual(f.events, ['mutation']);
  assert.equal(f.context.managerTab.instaToolboxAccountRunV1, undefined);
  assert.equal(f.context.managerTab.unrelatedTabData, 'preserved');
  assert.deepEqual(f.tabWrites.at(-1), { unrelatedTabData: 'preserved' });
  assert.match(f.messages.at(-1), /Keep this tab open/);
});

test('a full shared-and-manager storage outage prevents the initial native dispatch', async () => {
  const f = fixture({ targets: ['candidate', 'next'] });
  f.context.recordAction = () => { throw new Error('shared-storage-unavailable'); };
  f.context.GM_saveTab = () => { throw new Error('manager-storage-unavailable'); };
  const update = f.context.setRun;
  f.context.setRun = patch => {
    update(patch);
    if (patch.results) throw new Error('shared-storage-unavailable');
  };
  await f.context.continueAccountRun();
  assert.equal(f.run().status, 'stopped');
  assert.equal(f.run().completed, 0);
  assert.equal(f.run().queue.length, 0);
  assert.deepEqual(f.events, []);
  assert.match(f.messages.at(-1), /before reloading or trying again/);
});

test('a void save call with absent or mismatched readback cannot authorize a native dispatch', async () => {
  for (const readBack of [() => null, f => ({
    ...f.tabWrites.at(-1), instaToolboxAccountRunV1: {
      ...f.tabWrites.at(-1).instaToolboxAccountRunV1, pendingTarget: 'unreviewed',
    },
  })]) {
    const f = fixture();
    f.context.readManagerTab = async () => readBack(f);
    await f.context.continueAccountRun();
    assert.equal(f.run().status, 'stopped');
    assert.equal(f.run().completed, 0);
    assert.deepEqual(f.events, []);
  }
});

test('a persisted pending target blocks replay after a native result cannot be saved and the document reloads', async () => {
  const f = fixture({ targets: ['candidate', 'next'] });
  const persist = f.context.GM_saveTab;
  let outage = false;
  f.context.GM_saveTab = value => {
    if (outage) throw new Error('manager-storage-offline-after-click');
    return persist(value);
  };
  f.context.recordAction = () => { throw new Error('shared-storage-offline-after-click'); };
  f.context.engine.performReviewedProfileAction = async () => {
    f.events.push('mutation'); outage = true; return { result: 'followed', dispatched: true };
  };
  await f.context.continueAccountRun();
  assert.equal(f.run().completed, 1);
  assert.equal(f.run().status, 'stopped');
  assert.deepEqual(f.events, ['mutation']);
  const durable = f.tabWrites.at(-1).instaToolboxAccountRunV1;
  assert.equal(durable.pendingTarget, 'candidate');
  assert.equal(durable.queue.join(','), 'candidate,next');

  const reloaded = fixture({ targets: ['candidate', 'next'] });
  reloaded.context.state.run = reloaded.context.normalizeResumableAccountRun(JSON.parse(JSON.stringify(durable)));
  assert.equal(reloaded.run().pendingTarget, 'candidate');
  await reloaded.context.resumeApprovedAccountRun();
  assert.equal(reloaded.run().status, 'stopped');
  assert.equal(reloaded.run().queue.length, 0);
  assert.deepEqual(reloaded.events, []);
  assert.match(reloaded.messages.at(-1), /previous action has no saved outcome/);
});
