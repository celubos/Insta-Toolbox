import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const [labelsSource, inspectorSource, viewerSource, shellSource] = await Promise.all([
  '../extension/action-labels.js', '../extension/content-instagram.js',
  '../extension/instagram-viewer.js', '../userscripts/src/toolbox-shell.js',
].map(file => readFile(new URL(file, import.meta.url), 'utf8')));

// A synthetic native Home: a DIV navigation rail, unrelated story/feed avatars,
// and the signed-in account repeated in the right-hand card inside MAIN.
function fixture({ withViewer = true } = {}) {
  function matches(node, selector) {
    return selector.split(',').some(part => {
      const value = part.trim();
      const tag = value.match(/^[a-z][a-z0-9-]*/i)?.[0];
      if (tag && node.tagName !== tag.toUpperCase()) return false;
      return [...value.matchAll(/\[([\w-]+)(?:([\^]?=)"([^"]*)")?\]/g)].every(([, name, operator, expected]) => {
        const actual = node.getAttribute(name);
        return operator === '=' ? actual === expected
          : operator === '^=' ? actual?.startsWith(expected) : actual !== null;
      });
    });
  }
  function element(tag, attributes = {}, children = [], text = '') {
    const value = {
      tagName: tag.toUpperCase(), attributes, children, text, parentElement: null, isConnected: true,
      getAttribute(name) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null; },
      get textContent() { return this.text + this.children.map(child => child.textContent).join(''); },
      get innerText() { return this.textContent; },
      getClientRects() { return [{}]; },
      querySelectorAll(selector) {
        const descendants = this.children.flatMap(child => [child, ...child.querySelectorAll('*')]);
        return descendants.filter(child => matches(child, selector));
      },
      querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
      contains(other) { for (let node = other; node; node = node.parentElement) if (node === this) return true; return false; },
      closest(selector) { for (let node = this; node; node = node.parentElement) if (matches(node, selector)) return node; return null; },
    };
    for (const child of children) child.parentElement = value;
    return value;
  }
  const link = (href, text = '') => element('a', { role: 'link', href }, [], text);
  const avatar = name => element('a', { role: 'link', href: `/${name}/` }, [
    element('img', { alt: `${name}'s profile picture` }),
  ]);
  function navigation(name) {
    const profile = avatar(name); profile.text = 'Profile';
    const rail = element('div', {}, [link('/', 'Home'), link('/reels/', 'Reels'),
      link('/direct/inbox/', 'Messages'), link('/explore/', 'Search'),
      element('div', {}, [element('span', {}, [element('div', {}, [profile])])]),
    ]);
    return { rail, profile };
  }
  const owner = 'fixture.viewer';
  const { rail, profile } = navigation(owner);
  const card = element('div', {}, [avatar(owner), link(`/${owner}/`, owner)]);
  const main = element('main', {}, [
    element('div', {}, [avatar('story.person'), avatar('another.story')]),
    element('article', {}, [avatar('feed.author')]), card,
  ]);
  const root = element('div', {}, [rail, main]);
  const body = element('body', {}, [root]);
  const document = {
    body, visibilityState: 'visible', wasDiscarded: false,
    querySelectorAll: selector => body.querySelectorAll(selector),
    querySelector: selector => body.querySelector(selector),
  };
  const location = { origin: 'https://www.instagram.com', pathname: '/', href: 'https://www.instagram.com/' };
  const context = vm.createContext({ URL, document, location, setTimeout, clearTimeout,
    chrome: { runtime: { onMessage: { addListener() {} } } },
  });
  vm.runInContext(labelsSource, context);
  vm.runInContext(inspectorSource, context);
  if (withViewer) vm.runInContext(viewerSource, context);
  const presenceLogic = shellSource.slice(shellSource.indexOf('  const inspectPresenceAccount ='),
    shellSource.indexOf('  const stopPresenceSession ='));
  vm.runInContext(`const engine = globalThis.InstaToolboxInstagramInspector;
    ${presenceLogic}
    globalThis.inspectPresenceAccount = inspectPresenceAccount;`, context);
  return { context, document, location, root, main, rail, profile, element, navigation, owner,
    identity: () => context.InstaToolboxInstagramInspector.detectAuthenticatedUsername(),
    presence: () => context.inspectPresenceAccount(),
  };
}

test('native Home author avatars do not prevent verified Presence and Growth account identity', () => {
  const legacy = fixture({ withViewer: false });
  assert.equal(legacy.identity(), '', 'the old all-avatar identity reproduces the live failure');
  const f = fixture();
  assert.equal(f.identity(), f.owner);
  const account = f.presence();
  assert.equal(account.accountVerified, true);
  assert.equal(account.usable, true, 'Presence is usable on Home without a DM thread');
  assert.equal(account.accountId, f.owner);
  assert.equal(account.accountKey, f.context.InstaToolboxInstagramViewer.accountKey(f.owner));
});

test('a hidden or missing navigation profile cannot fall back to a matching right-hand account card', () => {
  for (const hide of [true, false]) {
    const f = fixture();
    if (hide) f.profile.attributes.hidden = '';
    else f.profile.attributes.href = '/different.owner/';
    assert.equal(f.identity(), '');
    assert.equal(f.presence().accountVerified, false);
  }
});

test('conflicting native navigation controls remain ambiguous despite one matching account card', () => {
  const f = fixture();
  const second = f.navigation('other.viewer');
  second.rail.parentElement = f.root; f.root.children.push(second.rail);
  assert.equal(f.identity(), '');
  assert.equal(f.presence().usable, false);
});

test('a conflicting inbox account picker cannot be replaced with Home avatar identity', () => {
  const f = fixture();
  const picker = f.element('div', { role: 'button', tabindex: '0' }, [f.element('h2', {}, [], 'other.viewer')]);
  const list = f.element('div', { 'aria-label': 'Thread list' }, [picker]);
  list.parentElement = f.main; f.main.children.push(list);
  assert.equal(f.identity(), '');
  assert.equal(f.presence().accountVerified, false);
});

test('restrictions and non-Instagram origins still prevent account actions', () => {
  for (const restrict of [
    f => { f.location.pathname = '/challenge/'; },
    f => { f.location.pathname = '/accounts/login/'; },
    f => { f.document.body.text = 'We restrict certain activity'; },
    f => { f.document.body.text = 'Please wait a few minutes'; },
    f => { f.location.origin = 'https://example.com'; },
  ]) {
    const f = fixture(); restrict(f);
    assert.equal(f.identity(), '');
    assert.equal(f.presence().usable, false);
  }
});

test('an unavailable verifier or inspection error never enables an avatar fallback', () => {
  for (const inspect of [
    () => ({ accountVerified: false, accountId: 'fixture.viewer' }),
    () => { throw new Error('fixture-inspection-unavailable'); },
  ]) {
    const f = fixture({ withViewer: false });
    f.main.children = f.main.children.slice(-1);
    assert.equal(f.identity(), f.owner, 'the legacy path would otherwise accept the remaining owner avatars');
    f.context.InstaToolboxInstagramViewer = { inspect };
    assert.equal(f.identity(), '');
    assert.equal(f.presence().accountVerified, false);
  }
});

test('a present but malformed viewer module cannot enable the legacy identity path', () => {
  for (const viewer of [undefined, null, {}, { inspect: 'unavailable' }]) {
    const f = fixture({ withViewer: false });
    f.main.children = f.main.children.slice(-1);
    assert.equal(f.identity(), f.owner);
    f.context.InstaToolboxInstagramViewer = viewer;
    assert.equal(f.identity(), '');
    assert.equal(f.presence().accountVerified, false);
  }
});
