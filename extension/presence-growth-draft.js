import { growthUsername } from './presence-growth.js';

const MAX_AGE = 30 * 60_000;
const TYPES = ['followers', 'following'];
const NATIVE_ROW_SOURCES = ['extension-scrolled-dom', 'extension-visible-dom', 'tampermonkey-visible-dom'];
const REASONS = new Set(['pagination-complete', 'instagram-limited-list', 'cursor-missing', 'count-mismatch',
  'count-unverified', 'count-changed', 'profile-count-disagreement', 'account-limit', 'page-limit',
  'native-list-complete', 'native-list-truncated', 'stopped', 'native-context-changed', 'native-list-loading-timeout']);
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const integer = value => Number.isSafeInteger(value) && value >= 0;
const identity = value => typeof value === 'string' && /^[1-9]\d{0,29}$/.test(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function keys(value, allowed, required = allowed) {
  return object(value) && Object.keys(value).every(key => allowed.includes(key))
    && required.every(key => Object.prototype.hasOwnProperty.call(value, key));
}
function handle(value) {
  return typeof value === 'string' && growthUsername(value) === value ? value : '';
}
function timestamp(value) {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && new Date(parsed).toISOString() === value ? parsed : null;
}
function rows(value, { max, source, nativeIds = true, seedRead = false } = {}) {
  if (!Array.isArray(value) || value.length > max) return null;
  const names = new Set(), ids = new Set(), output = [];
  for (const row of value) {
    if (!keys(row, ['username', 'source', 'instagramId', 'instagramIdAmbiguous', 'profileUrl', 'displayName'], ['username', 'source'])
      || !handle(row.username) || names.has(row.username)
      || (source === 'authenticated-web' ? row.source !== 'authenticated-instagram-web'
        : source === 'list-dialog' ? !NATIVE_ROW_SOURCES.includes(row.source)
          : ![...NATIVE_ROW_SOURCES, 'authenticated-instagram-web'].includes(row.source))
      || (seedRead && source === 'list-dialog' && row.source !== 'extension-scrolled-dom')
      || (row.profileUrl !== undefined && row.profileUrl !== `https://www.instagram.com/${row.username}/`)
      || (row.displayName !== undefined && (typeof row.displayName !== 'string' || row.displayName.length > 500))
      || (row.instagramId !== undefined && (!nativeIds || !identity(row.instagramId) || ids.has(row.instagramId)))
      || (row.instagramIdAmbiguous !== undefined && (!nativeIds || seedRead || row.instagramIdAmbiguous !== true))
      || (row.instagramId && row.instagramIdAmbiguous)) return null;
    names.add(row.username);
    if (row.instagramId) ids.add(row.instagramId);
    output.push({ username: row.username, source: row.source,
      ...(row.instagramId ? { instagramId: row.instagramId } : {}),
      ...(row.instagramIdAmbiguous ? { instagramIdAmbiguous: true } : {}),
      profileUrl: `https://www.instagram.com/${row.username}/`,
      displayName: row.displayName || '' });
  }
  return output.sort((left, right) => left.username.localeCompare(right.username));
}

export function growthFollowingSnapshot(value, { actor, now = Date.now() } = {}) {
  try {
    if (!handle(actor) || !integer(now) || !keys(value,
      ['subjectUsername', 'listType', 'verified', 'source', 'capturedAt', 'complete', 'accounts'])
      || value.subjectUsername !== actor || value.listType !== 'following' || value.verified !== true
      || !['list-dialog', 'authenticated-web'].includes(value.source) || typeof value.complete !== 'boolean') return null;
    const captured = timestamp(value.capturedAt);
    const accounts = rows(value.accounts, { max: 25_000, source: value.source });
    if (captured === null || captured > now || now - captured >= MAX_AGE || !accounts) return null;
    return freeze({ subjectUsername: actor, listType: 'following', verified: true, source: value.source,
      capturedAt: value.capturedAt, complete: value.complete, accounts });
  } catch { return null; }
}

// An integrity checksum plus full snapshot comparison detects storage corruption.
// This read-only record is never a receipt or permission to perform an action.
export function snapshotDigest(snapshot) {
  const serialized = JSON.stringify(snapshot);
  let hash = 0x811c9dc5;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index); hash = Math.imul(hash, 0x01000193);
  }
  return `growth-following-v1-${serialized.length}-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function normalizedRead(value, seed, createdAt, now) {
  if (!keys(value, ['username', 'source', 'startedAt', 'capturedAt', 'partial', 'lists'])
    || value.username !== seed || !['list-dialog', 'authenticated-instagram-web'].includes(value.source)
    || !integer(value.startedAt) || value.startedAt < createdAt || value.startedAt > now
    || typeof value.partial !== 'boolean' || !keys(value.lists, TYPES)) return null;
  const observedAt = timestamp(value.capturedAt);
  if (observedAt === null || observedAt < value.startedAt || observedAt > now) return null;
  const native = value.source === 'list-dialog', lists = {};
  for (const type of TYPES) {
    const list = value.lists[type];
    if (!keys(list, ['owner', 'listType', 'source', 'verified', 'complete', 'capturedAt', 'expectedCount', 'pages', 'reason', 'accounts'])
      || list.owner !== seed || list.listType !== type || list.source !== value.source
      || typeof list.verified !== 'boolean' || typeof list.complete !== 'boolean'
      || timestamp(list.capturedAt) === null || timestamp(list.capturedAt) < createdAt || timestamp(list.capturedAt) > observedAt
      || (list.expectedCount !== null && !integer(list.expectedCount))
      || (native ? list.pages !== null : !integer(list.pages) || list.pages > 1_000)
      || (list.reason === 'native-list-loading-timeout' && (!native || value.partial !== true))
      || !REASONS.has(list.reason) || (list.complete && (!list.verified
        || list.reason !== (native ? 'native-list-complete' : 'pagination-complete')))) return null;
    const accounts = rows(list.accounts, { max: 2_000, source: native ? 'list-dialog' : 'authenticated-web', nativeIds: !native, seedRead: true });
    if (!accounts || (!list.verified && accounts.length)
      || (list.complete && (list.expectedCount === null || list.expectedCount !== accounts.length))) return null;
    lists[type] = { owner: seed, listType: type, source: value.source, verified: list.verified,
      complete: list.complete, capturedAt: list.capturedAt, expectedCount: list.expectedCount,
      pages: list.pages, reason: list.reason, accounts };
  }
  return { username: seed, source: value.source, startedAt: value.startedAt,
    capturedAt: value.capturedAt, partial: value.partial, lists };
}

export function validateGrowthReadDraft(value, { actor, followingSnapshot, now = Date.now() } = {}) {
  try {
    const fields = ['schemaVersion', 'kind', 'id', 'actor', 'createdAt', 'expiresAt', 'status', 'revision',
      'followingSnapshot', 'followingDigest', 'followers', 'seeds', 'results'];
    if (!keys(value, fields) || value.schemaVersion !== 1 || value.kind !== 'growth-read-draft'
      || !handle(actor) || value.actor !== actor || typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value.id)
      || !integer(now) || !integer(value.createdAt) || value.createdAt <= 0 || value.createdAt > now
      || !integer(value.expiresAt) || value.expiresAt <= now || value.expiresAt <= value.createdAt
      || value.expiresAt > value.createdAt + MAX_AGE || !['active', 'stopped'].includes(value.status)
      || !integer(value.revision) || value.revision > 100_000) return null;
    const snapshot = growthFollowingSnapshot(value.followingSnapshot, { actor, now });
    const current = growthFollowingSnapshot(followingSnapshot, { actor, now });
    if (!snapshot || !current || value.followingDigest !== snapshotDigest(snapshot)
      || JSON.stringify(snapshot) !== JSON.stringify(current)
      || value.expiresAt > timestamp(snapshot.capturedAt) + MAX_AGE) return null;
    const followers = rows(value.followers, { max: 25_000 });
    const followingNames = new Set(snapshot.accounts.map(row => row.username));
    if (!followers || !Array.isArray(value.seeds) || value.seeds.length < 1 || value.seeds.length > 3
      || value.seeds.some(seed => !handle(seed) || seed === actor || !followingNames.has(seed))
      || new Set(value.seeds).size !== value.seeds.length || !object(value.results)
      || Object.keys(value.results).some(seed => !value.seeds.includes(seed))) return null;
    const results = Object.create(null);
    for (const seed of value.seeds) {
      if (!Object.prototype.hasOwnProperty.call(value.results, seed)) continue;
      const read = normalizedRead(value.results[seed], seed, value.createdAt, now);
      if (!read) return null;
      results[seed] = read;
    }
    return freeze({ schemaVersion: 1, kind: 'growth-read-draft', id: value.id, actor,
      createdAt: value.createdAt, expiresAt: value.expiresAt, status: value.status, revision: value.revision,
      followingSnapshot: snapshot, followingDigest: value.followingDigest, followers, seeds: [...value.seeds], results });
  } catch { return null; }
}

function checkedDraft(value, now) {
  const draft = validateGrowthReadDraft(value, { actor: value?.actor, followingSnapshot: value?.followingSnapshot, now });
  if (!draft) throw new Error('growth-read-draft-invalid');
  return draft;
}

export function createGrowthReadDraft({ actor, followingSnapshot, followers = [], seeds, now = Date.now(), id } = {}) {
  const snapshot = growthFollowingSnapshot(followingSnapshot, { actor, now });
  if (!snapshot) throw new Error('growth-following-snapshot-invalid');
  const draft = validateGrowthReadDraft({ schemaVersion: 1, kind: 'growth-read-draft', id, actor, createdAt: now,
    expiresAt: Math.min(now + MAX_AGE, timestamp(snapshot.capturedAt) + MAX_AGE), status: 'active', revision: 0,
    followingSnapshot: snapshot, followingDigest: snapshotDigest(snapshot), followers, seeds, results: {} },
  { actor, followingSnapshot: snapshot, now });
  if (!draft) throw new Error('growth-read-draft-invalid');
  return draft;
}

export function recordGrowthSeedRead(value, { seed, result, startedAt, now = Date.now(), partial = false } = {}) {
  const draft = checkedDraft(value, now);
  if ((draft.status !== 'active' && partial !== true) || !draft.seeds.includes(seed) || !integer(startedAt)
    || startedAt < draft.createdAt || startedAt > now || typeof partial !== 'boolean') throw new Error('growth-seed-read-invalid');
  const native = result?.source === 'list-dialog';
  const allowed = ['username', 'source', 'capturedAt', 'followers', 'following', 'verified', 'complete', 'expectedCounts', 'pages', 'reasons',
    ...(native ? [] : ['userId', 'subjectInstagramId'])];
  const required = ['username', 'source', 'capturedAt', 'followers', 'following', 'complete', 'expectedCounts', 'pages', 'reasons',
    ...(native ? ['verified'] : ['userId', 'subjectInstagramId'])];
  if (!keys(result, allowed, required) || result.username !== seed
    || !['list-dialog', 'authenticated-instagram-web'].includes(result.source)
    || !keys(result.complete, TYPES) || !keys(result.expectedCounts, TYPES) || !keys(result.pages, TYPES) || !keys(result.reasons, TYPES)
    || (native ? !keys(result.verified, TYPES) : !identity(result.userId) || result.subjectInstagramId !== result.userId)
    || (result.verified !== undefined && !keys(result.verified, TYPES))) throw new Error('growth-seed-read-invalid');
  const lists = {};
  for (const type of TYPES) {
    const verified = native ? result.verified[type] : result.verified?.[type] ?? true;
    lists[type] = { owner: seed, listType: type, source: result.source, verified, complete: result.complete[type],
      capturedAt: result.capturedAt, expectedCount: result.expectedCounts[type], pages: result.pages[type],
      reason: result.reasons[type], accounts: result[type] };
  }
  const read = normalizedRead({ username: seed, source: result.source, startedAt,
    capturedAt: result.capturedAt, partial, lists }, seed, draft.createdAt, now);
  if (!read) throw new Error('growth-seed-read-invalid');
  const previous = draft.results[seed];
  // An interrupted retry cannot replace an already completed observation.
  if (partial && previous && !previous.partial && TYPES.every(type => previous.lists[type].verified)) return draft;
  if (partial && previous?.source === read.source) {
    for (const type of TYPES) {
      if (!read.lists[type].verified && previous.lists[type].verified) read.lists[type] = previous.lists[type];
    }
  }
  return freeze({ ...draft, revision: draft.revision + 1, results: { ...draft.results, [seed]: read } });
}

export function stopGrowthReadDraft(value, { now = Date.now() } = {}) {
  const draft = checkedDraft(value, now);
  return freeze({ ...draft, status: 'stopped', revision: draft.revision + 1 });
}

export function resumeGrowthReadDraft(value, { now = Date.now() } = {}) {
  const draft = checkedDraft(value, now);
  return freeze({ ...draft, status: 'active', revision: draft.revision + 1 });
}

export function growthDraftSeedSources(draft) {
  return (draft?.seeds || []).flatMap(seed => {
    const read = draft.results?.[seed];
    return read && !read.partial && TYPES.every(type => read.lists?.[type]?.verified === true)
      ? [{ username: seed, followers: read.lists.followers.accounts, following: read.lists.following.accounts }] : [];
  });
}

export function growthDraftSeedDone(draft, seed) {
  return growthDraftSeedSources(draft).some(source => source.username === seed);
}
