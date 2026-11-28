import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readLoadedInsights, summarizeLoadedPosts, formatInsightsReport } from '../extension/insights.js';

const options = { sourceUrl: 'https://www.instagram.com/example/', capturedAt: '2026-09-24T12:00:00.000Z' };
const nativeProfileContract = JSON.parse(await readFile(new URL('./fixtures/native-instagram-profile-contract.json', import.meta.url), 'utf8'));

test('content insights deduplicate recycled post identities, not matching text', () => {
  const value = summarizeLoadedPosts([
    { url: '/p/one/', hashtags: ['#Café', '東京'], publishedAt: '2026-09-21T23:00:00Z', type: 'video' },
    { url: '/reels/one/', hashtags: ['CAFÉ', 'new'] },
    { url: '/p/two/', hashtags: ['café'], type: 'carousel' },
    { url: 'https://other.example/p/one/', type: 'photo' },
    { url: '/p/two/liked_by/' },
  ], options);
  assert.equal(value.posts.length, 2);
  assert.deepEqual(value.counts, { photo: 0, video: 1, carousel: 1, unknown: 0 });
  assert.equal(value.hashtags.find(row => row.tag === 'café').posts, 2);
  assert.equal(value.hashtags.find(row => row.tag === '東京').posts, 1);
  assert.equal(value.datedPosts, 1);
  assert.equal(value.weekdays[1], 1);
  assert.equal(value.timezone, 'UTC');
  assert.equal(value.coverage, 'loaded-posts-only');
});

test('unknown media and missing dates are not invented and report stays inert', () => {
  const report = summarizeLoadedPosts([{ url: '/p/abc/', hashtags: ['<script>', 'valid_123'], publishedAt: 'invalid' }], options);
  assert.equal(report.counts.unknown, 1);
  assert.equal(report.datedPosts, 0);
  assert.equal(report.posts[0].publishedAt, null);
  assert.deepEqual(report.hashtags, [{ tag: 'valid_123', posts: 1 }]);
  const text = formatInsightsReport(report);
  assert.match(text, /1 loaded posts — not complete account history/);
  assert.match(text, /Date unavailable/);
  assert.match(text, /https:\/\/www\.instagram\.com\/p\/abc\//);
  assert.doesNotMatch(text, /<script>/i);
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
});

test('Insights never reads DMs, requests a remote service, or treats an empty sample as full history', () => {
  const document = { querySelectorAll() { return []; } };
  assert.throws(() => readLoadedInsights({ document, location: new URL('https://www.instagram.com/direct/inbox/') }), /profile or feed/);
  assert.throws(() => readLoadedInsights({ document, location: new URL('https://example.org/') }), /Instagram/);
  const report = readLoadedInsights({ document, location: new URL(options.sourceUrl), now: () => options.capturedAt });
  assert.equal(report.posts.length, 0);
  assert.equal(report.profile, null);
  assert.equal(report.coverage, 'loaded-posts-only');
  assert.equal(report.capturedAt, options.capturedAt);
  assert.throws(() => summarizeLoadedPosts(Array(1001).fill({}), options), /Too many/);
});

test('profile-grid permalinks remain readable without article wrappers or invented media details', () => {
  const link = (href, shown = true) => ({ isConnected: true, getClientRects: () => shown ? [{}] : [],
    closest: () => null, querySelectorAll: () => [], getAttribute: name => name === 'href' ? href : null });
  const links = [link('/p/grid_one/'), link('/reel/grid_two/'), link('/p/grid_one/'),
    link('/p/hidden/', false), link('https://other.example/p/no/'), link('/explore/')];
  const report = readLoadedInsights({ document: { querySelectorAll: selector => selector === 'main a[href]' ? links : [] },
    location: new URL(options.sourceUrl), now: () => options.capturedAt });
  assert.equal(report.posts.length, 2);
  assert.equal(report.counts.unknown, 2);
  assert.equal(report.datedPosts, 0);
  assert.equal(report.coverage, 'loaded-posts-only');
});

test('exact prefixed post routes deduplicate with canonical links and reject unrelated path shapes', () => {
  const credentialed = new URL('https://www.instagram.com/target_name/p/no/');
  credentialed.username = 'fixture';
  credentialed.password = 'test';
  const report = summarizeLoadedPosts([
    { url: '/target_name/p/native_fixture_one/' }, { url: '/p/native_fixture_one/' },
    { url: '/target_name/reel/native_fixture_two/' }, { url: '/target_name/reels/native_fixture_three/' },
    { url: '/accounts/p/no/' }, { url: '/direct/p/no/' }, { url: '/target_name/p/no/liked_by/' },
    { url: '/too/many/p/no/' }, { url: 'https://example.org/target_name/p/no/' },
    { url: credentialed.href },
    { url: '/invalid%2Fowner/p/no/' },
  ], options);
  assert.deepEqual(report.posts.map(post => post.id), ['native_fixture_one', 'native_fixture_two', 'native_fixture_three']);
  assert.equal(report.posts.every(post => /^https:\/\/www\.instagram\.com\/p\/[\w-]+\/$/.test(post.url)), true);
});

function nativeProfileDocument({ owner = nativeProfileContract.username, headerCopies = 1, external = false } = {}) {
  const link = (href, text = '') => ({ isConnected: true, textContent: text,
    getClientRects: () => [{}], closest: () => null, querySelectorAll: () => [],
    getAttribute: name => name === 'href' ? href : name === 'role' ? 'link' : null,
  });
  const counters = nativeProfileContract.counterLinks.map(item => link(external ? `https://example.org/${owner}/` : `/${owner}/`, item.text));
  const header = { isConnected: true, textContent: owner, getClientRects: () => [{}], closest: () => null,
    querySelectorAll: () => counters,
  };
  const grid = nativeProfileContract.gridLinks.map(item => link(item.href));
  return { querySelectorAll: selector => selector === 'main header' ? Array(headerCopies).fill(header)
    : selector === 'main a[href]' ? grid : [] };
}

test('observed native profile grid and same-href labeled counters produce a truthful loaded sample', () => {
  const report = readLoadedInsights({ document: nativeProfileDocument(),
    location: new URL(`https://www.instagram.com${nativeProfileContract.pathname}`), now: () => options.capturedAt });
  assert.equal(report.posts.length, 2);
  assert.deepEqual(report.profile, { username: nativeProfileContract.username, followers: '3 followers', following: '2 following' });
  assert.equal(report.counts.unknown, 2, 'a grid thumbnail does not establish the media type');
  assert.equal(report.datedPosts, 0);
});

test('Insights does not attach counters from another, ambiguous or external profile header', () => {
  for (const config of [{ owner: 'another_owner' }, { headerCopies: 2 }, { external: true }]) {
    const report = readLoadedInsights({ document: nativeProfileDocument(config),
      location: new URL(`https://www.instagram.com${nativeProfileContract.pathname}`) });
    assert.equal(report.profile, null);
  }
});

function mediaFixtureNode(tag, attributes = {}, children = []) {
  const matches = (node, selector) => selector === '[aria-label]' ? node.getAttribute('aria-label') !== null
    : selector === 'a[href]' ? node.tagName === 'A' && node.getAttribute('href') !== null
      : selector === 'time[datetime]' ? node.tagName === 'TIME' && node.getAttribute('datetime') !== null
        : selector === '[hidden], [aria-hidden="true"]' ? node.getAttribute('hidden') !== null || node.getAttribute('aria-hidden') === 'true'
          : node.tagName.toLowerCase() === selector;
  const node = { tagName: tag.toUpperCase(), isConnected: true, parentElement: null,
    getAttribute: name => attributes[name] ?? null,
    getClientRects: () => attributes.noRects ? [] : [{}],
    closest(selector) {
      for (let current = this; current; current = current.parentElement) if (matches(current, selector)) return current;
      return null;
    },
    querySelectorAll(selector) {
      return children.flatMap(child => [...(matches(child, selector) ? [child] : []), ...child.querySelectorAll(selector)]);
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
  };
  for (const child of children) child.parentElement = node;
  return node;
}

test('native profile-grid permalinks use their own visible carousel markers only', () => {
  const marker = (label = 'Carousel', attributes = {}) => mediaFixtureNode('svg', { 'aria-label': label, ...attributes });
  const thumbnail = (id, children = [], href = `/fixture_owner/p/${id}/`) => mediaFixtureNode('a', { href }, [mediaFixtureNode('img'), ...children]);
  const links = [
    thumbnail('carousel', [marker()]),
    thumbnail('slide', [marker('Slide 2 of 4')]),
    thumbnail('plain'),
    thumbnail('hidden', [mediaFixtureNode('span', { hidden: '' }, [marker()])]),
    thumbnail('aria_hidden', [mediaFixtureNode('span', { 'aria-hidden': 'true' }, [marker()])]),
    thumbnail('no_rect', [marker('Carousel', { noRects: true })]),
    thumbnail('caption', [marker('A carousel of photos')]),
    thumbnail('foreign', [marker()], 'https://example.org/fixture_owner/p/foreign/'),
  ];
  // A neighboring indicator outside the plain post's permalink does not describe that post.
  mediaFixtureNode('div', {}, [links[2], marker()]);
  const document = { querySelectorAll: selector => selector === 'main a[href]' ? links : [] };
  const report = readLoadedInsights({ document, location: new URL(options.sourceUrl), now: () => options.capturedAt });
  assert.deepEqual(report.posts.map(post => [post.id, post.type]), [
    ['carousel', 'carousel'], ['slide', 'carousel'], ['plain', 'unknown'], ['hidden', 'unknown'],
    ['aria_hidden', 'unknown'], ['no_rect', 'unknown'], ['caption', 'unknown'],
  ]);
  assert.deepEqual(report.counts, { photo: 0, video: 0, carousel: 2, unknown: 5 });
  assert.equal(report.datedPosts, 0);
  assert.deepEqual(report.hashtags, []);
});

test('article carousel and video evidence retain their existing precedence', () => {
  const article = (id, children) => mediaFixtureNode('article', {}, [mediaFixtureNode('a', { href: `/p/${id}/` }), ...children]);
  const articles = [
    article('article_carousel', [mediaFixtureNode('video'), mediaFixtureNode('svg', { 'aria-label': 'Carousel' })]),
    article('article_video', [mediaFixtureNode('video'), mediaFixtureNode('svg', { 'aria-label': 'Carousel', hidden: '' })]),
    article('article_unknown', [mediaFixtureNode('img')]),
  ];
  const report = readLoadedInsights({ document: { querySelectorAll: selector => selector === 'article' ? articles : [] },
    location: new URL(options.sourceUrl), now: () => options.capturedAt });
  assert.deepEqual(report.posts.map(post => post.type), ['carousel', 'video', 'unknown']);
});
