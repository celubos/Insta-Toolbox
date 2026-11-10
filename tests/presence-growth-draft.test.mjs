import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createGrowthReadDraft, growthDraftSeedDone, growthDraftSeedSources, growthFollowingSnapshot,
  recordGrowthSeedRead, resumeGrowthReadDraft, snapshotDigest, stopGrowthReadDraft, validateGrowthReadDraft,
} from '../extension/presence-growth-draft.js';

const NOW = 1_800_000_000_000;
const iso = clock => new Date(clock).toISOString();
const copy = value => JSON.parse(JSON.stringify(value));
const row = (username, source = 'extension-scrolled-dom', extra = {}) => ({ username, source,
  profileUrl: `https://www.instagram.com/${username}/`, displayName: '', ...extra });
const snapshot = (seeds = ['seed_a', 'seed_b', 'seed_c']) => ({ subjectUsername: 'owner', listType: 'following',
  verified: true, source: 'list-dialog', capturedAt: iso(NOW - 1_000), complete: true,
  accounts: seeds.map(name => row(name)) });
const create = (seeds = ['seed_a'], extra = {}) => createGrowthReadDraft({ actor: 'owner',
  followingSnapshot: snapshot(), followers: [row('existing_follower')], seeds, now: NOW, id: 'fixture-draft', ...extra });
const native = (username, clock = NOW + 10, extra = {}) => ({ username, source: 'list-dialog', capturedAt: iso(clock),
  followers: [row('candidate')], following: [row('candidate')], verified: { followers: true, following: true },
  complete: { followers: true, following: true }, expectedCounts: { followers: 1, following: 1 },
  pages: { followers: null, following: null }, reasons: { followers: 'native-list-complete', following: 'native-list-complete' }, ...extra });
const record = (draft, seed = 'seed_a', result = native(seed), options = {}) => recordGrowthSeedRead(draft,
  { seed, result, startedAt: NOW, now: NOW + 10, ...options });
const validate = (draft, options = {}) => validateGrowthReadDraft(draft,
  { actor: 'owner', followingSnapshot: snapshot(), now: NOW + 20, ...options });

test('one to three explicit seed reads survive serialization without acquiring action authority', () => {
  for (let count = 1; count <= 3; count += 1) {
    const seeds = ['seed_a', 'seed_b', 'seed_c'].slice(0, count);
    let draft = create(seeds);
    for (const [index, seed] of seeds.entries()) {
      const clock = NOW + 10 + index;
      draft = record(draft, seed, native(seed, clock), { now: clock });
      draft = validate(copy(draft));
      assert.ok(draft);
      assert.equal(growthDraftSeedDone(draft, seed), true);
      assert.equal(growthDraftSeedSources(draft).length, index + 1);
      assert.equal(draft.results[seed].lists.followers.owner, seed);
      assert.equal(draft.results[seed].lists.following.source, 'list-dialog');
      assert.equal(draft.results[seed].lists.following.capturedAt, iso(clock));
    }
    assert.deepEqual(growthDraftSeedSources(draft).map(item => item.username), seeds);
    assert.equal(draft.actor, 'owner');
    assert.equal(draft.status, 'active');
    assert.equal(draft.revision, count);
    assert.equal(Object.isFrozen(draft.followingSnapshot.accounts[0]), true);
    assert.doesNotMatch(JSON.stringify(draft), /approvedTargets|capabilityId|approval|growthCampaignId|actionToken/);
  }
});

test('actual API seed observations retain API provenance beside later native reads', () => {
  const api = native('seed_a', NOW + 10, { source: 'authenticated-instagram-web', userId: '77', subjectInstagramId: '77',
    followers: [row('candidate', 'authenticated-instagram-web', { instagramId: '123' })],
    following: [row('candidate', 'authenticated-instagram-web', { instagramId: '123' })],
    pages: { followers: 1, following: 1 }, reasons: { followers: 'pagination-complete', following: 'pagination-complete' } });
  delete api.verified;
  let draft = record(create(['seed_a', 'seed_b']), 'seed_a', api);
  draft = record(draft, 'seed_b', native('seed_b', NOW + 11), { now: NOW + 11 });
  const loaded = validate(copy(draft));
  assert.equal(loaded.results.seed_a.lists.followers.source, 'authenticated-instagram-web');
  assert.equal(loaded.results.seed_a.lists.followers.accounts[0].instagramId, '123');
  assert.equal(loaded.results.seed_b.lists.followers.source, 'list-dialog');
  assert.equal('instagramId' in loaded.results.seed_b.lists.followers.accounts[0], false);
  assert.equal(growthDraftSeedSources(loaded).length, 2);
});

test('actor and the complete Following snapshot remain bound across reload and before use', () => {
  const draft = record(create());
  assert.equal(validate(copy(draft), { actor: 'other' }), null);
  for (const change of [
    value => { value.accounts.pop(); },
    value => { value.accounts.push(row('newly_followed')); },
    value => { value.complete = false; },
    value => { value.capturedAt = iso(NOW); },
    value => { value.source = 'authenticated-web'; },
    value => { value.verified = false; },
    value => { value.subjectUsername = 'other'; },
  ]) {
    const current = snapshot(); change(current);
    assert.equal(validate(copy(draft), { followingSnapshot: current }), null);
  }
  const reordered = snapshot(); reordered.accounts.reverse();
  assert.ok(validate(copy(draft), { followingSnapshot: reordered }), 'row order alone is normalized');
});

test('expired, future, oversized and forged drafts are rejected rather than normalized into authority', () => {
  const draft = record(create());
  const mutations = [
    value => { value.approvedTargets = ['candidate']; },
    value => { value.kind = 'growth-campaign'; },
    value => { value.followingDigest = 'forged'; },
    value => { value.actor = 'other'; },
    value => { value.createdAt = NOW + 100; },
    value => { value.expiresAt = NOW + 31 * 60_000; },
    value => { value.seeds = ['stranger']; },
    value => { value.seeds = ['seed_a', 'seed_a']; },
    value => { value.followingSnapshot.accounts[0].action = 'follow'; },
    value => { value.results.seed_a.lists.followers.owner = 'other'; },
    value => { value.results.seed_a.lists.followers.source = 'authenticated-instagram-web'; },
    value => { value.results.seed_a.lists.followers.capturedAt = iso(NOW + 21); },
    value => { value.results.seed_a.lists.followers.accounts[0].instagramId = '123'; },
    value => { value.results.seed_a.lists.followers.accounts[0].profileUrl = 'https://example.org/candidate/'; },
    value => { value.results.seed_a.lists.followers.accounts = Array(2_001).fill(row('candidate')); },
    value => { value.results.seed_a.lists.followers.complete = true; value.results.seed_a.lists.followers.reason = 'stopped'; },
  ];
  for (const mutate of mutations) {
    const forged = copy(draft); mutate(forged); assert.equal(validate(forged), null);
  }
  assert.equal(validate(copy(draft), { now: draft.expiresAt }), null);
  assert.equal(growthFollowingSnapshot({ ...snapshot(), capturedAt: iso(NOW + 1) }, { actor: 'owner', now: NOW }), null);
  assert.throws(() => create(['seed_a', 'seed_b', 'seed_c', 'seed_d']), /growth-read-draft-invalid/);
  assert.throws(() => create(['stranger']), /growth-read-draft-invalid/);
  assert.throws(() => create(['seed_a'], { followingSnapshot: { ...snapshot(), capturedAt: iso(NOW - 30 * 60_000) } }), /snapshot-invalid/);
});

test('Stop retains partial per-list provenance while late complete results cannot restart reads', () => {
  let draft = create();
  const first = native('seed_a', NOW + 10, { following: [], verified: { followers: true, following: false },
    complete: { followers: true, following: false }, expectedCounts: { followers: 1, following: 1 },
    reasons: { followers: 'native-list-complete', following: 'stopped' } });
  draft = record(draft, 'seed_a', first, { partial: true });
  assert.equal(growthDraftSeedDone(draft, 'seed_a'), false);
  draft = stopGrowthReadDraft(draft, { now: NOW + 11 });
  assert.equal(draft.status, 'stopped');
  assert.throws(() => record(draft, 'seed_a', native('seed_a', NOW + 12), { now: NOW + 12 }), /seed-read-invalid/);
  const late = native('seed_a', NOW + 12, { followers: [], verified: { followers: false, following: true },
    complete: { followers: false, following: true }, reasons: { followers: 'stopped', following: 'native-list-complete' } });
  draft = record(draft, 'seed_a', late, { partial: true, startedAt: NOW + 11, now: NOW + 12 });
  assert.equal(draft.status, 'stopped');
  assert.equal(draft.results.seed_a.lists.followers.capturedAt, iso(NOW + 10));
  assert.equal(draft.results.seed_a.lists.followers.accounts[0].username, 'candidate');
  assert.equal(draft.results.seed_a.lists.following.capturedAt, iso(NOW + 12));
  assert.equal(growthDraftSeedSources(draft).length, 0, 'interrupted reads never become completed observations');
  draft = validate(copy(draft));
  draft = resumeGrowthReadDraft(draft, { now: NOW + 21 });
  assert.equal(draft.status, 'active');
  const incomplete = native('seed_a', NOW + 22, { complete: { followers: false, following: false },
    expectedCounts: { followers: 2, following: 2 }, reasons: { followers: 'native-list-truncated', following: 'native-list-truncated' } });
  draft = record(draft, 'seed_a', incomplete, { startedAt: NOW + 21, now: NOW + 22 });
  assert.equal(growthDraftSeedDone(draft, 'seed_a'), true, 'two verified partial lists prove only their observed mutuals');
  assert.equal(draft.results.seed_a.lists.followers.complete, false);
});

test('an interrupted retry cannot erase an already finished seed observation', () => {
  const draft = record(create());
  const interrupted = native('seed_a', NOW + 12, { followers: [], following: [],
    verified: { followers: false, following: false }, complete: { followers: false, following: false },
    reasons: { followers: 'stopped', following: 'stopped' } });
  const retained = record(draft, 'seed_a', interrupted, { partial: true, now: NOW + 12 });
  assert.deepEqual(copy(retained), copy(draft));
  assert.equal(retained.revision, draft.revision);
});

test('seed records reject wrong owner, timestamps, provenance, IDs and malformed diagnostics', () => {
  const draft = create();
  for (const mutate of [
    value => { value.username = 'seed_b'; },
    value => { value.capturedAt = iso(NOW - 1); },
    value => { value.capturedAt = iso(NOW + 11); },
    value => { value.source = 'authenticated-web'; },
    value => { value.subjectInstagramId = '123'; },
    value => { value.followers[0].source = 'authenticated-instagram-web'; },
    value => { value.followers[0].instagramId = '123'; },
    value => { value.followers[0].instagramIdAmbiguous = true; },
    value => { value.verified.followers = false; },
    value => { value.pages.followers = 1; },
    value => { value.expectedCounts.followers = 99; },
    value => { value.reasons.followers = 'invented'; },
    value => { value.complete.followers = 'true'; },
    value => { value.confirmation = { approved: true }; },
  ]) {
    const invalid = native('seed_a'); mutate(invalid);
    assert.throws(() => record(draft, 'seed_a', invalid), /growth-seed-read-invalid/);
  }
});

test('special legal handles stay ordinary own data keys and snapshots are deterministic', () => {
  const following = snapshot(['__proto__']);
  let draft = create(['__proto__'], { followingSnapshot: following });
  draft = record(draft, '__proto__', native('__proto__'));
  const loaded = validateGrowthReadDraft(copy(draft), { actor: 'owner', followingSnapshot: following, now: NOW + 20 });
  assert.equal(growthDraftSeedSources(loaded)[0].username, '__proto__');
  assert.equal(Object.prototype.polluted, undefined);
  const normalized = growthFollowingSnapshot(snapshot(), { actor: 'owner', now: NOW });
  assert.equal(snapshotDigest(normalized), snapshotDigest(copy(normalized)));
});
