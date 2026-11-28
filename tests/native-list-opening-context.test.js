import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
const [labelsSource, inspectorSource, viewerSource, shellSource] = await Promise.all([
  '../extension/action-labels.js', '../extension/content-instagram.js',
  '../extension/instagram-viewer.js', '../userscripts/src/toolbox-shell.js',
].map(file => readFile(new URL(file, import.meta.url), 'utf8')));
// Native DOM fixture shared in shape with the existing Viewer integration suite.
function fixture({ withViewer = true } = {}) {
  function matches(node, selector) {
    return selector.split(',').some(part => {
      const value = part.trim();
      if (value === 'main header') {
        return node.tagName === 'HEADER' && node.parentElement?.closest('main');
      }
      const tag = value.match(/^[a-z][a-z0-9-]*/i)?.[0];
      if (tag && node.tagName !== tag.toUpperCase()) return false;
      return [...value.matchAll(/\[([\w-]+)(?:([\^*]?=)"([^"]*)"(?:\s+i)?)?\]/g)].every(([, name, operator, expected]) => {
        const actual = node.getAttribute(name);
        return operator === '=' ? actual === expected
          : operator === '^=' ? actual?.startsWith(expected)
            : operator === '*=' ? actual?.toLowerCase().includes(expected.toLowerCase()) : actual !== null;
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
  const context = vm.createContext({ URL, AbortController, document, location, setTimeout, clearTimeout,
    getComputedStyle: node => ({ display: node.style?.display || 'block', visibility: node.style?.visibility || 'visible',
      opacity: node.style?.opacity ?? '1', overflowY: 'visible' }),
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


function openingFixture() {
  const f = fixture();
  f.location.pathname = '/fixture.target/'; f.location.href = 'https://www.instagram.com/fixture.target/';
  const heading = f.element('h2', {}, [], 'fixture.target');
  const followers = f.element('a', { role: 'link', href: '#' }, [], '2 followers');
  const following = f.element('a', { role: 'link', href: '#' }, [], '1 following');
  const header = f.element('header', {}, [heading, followers, following]);
  header.parentElement = f.main; f.main.children = [header];
  let restricted = false, active = true;
  const options = { document: f.document, location: f.location, profileHeader: header,
    username: 'fixture.target', listType: 'followers', actor: f.owner,
    readSession: () => ({ rateLimited: restricted }), isActive: () => active };
  const open = (title = '') => {
    const modalTitle = f.element('h2', {}, [], title);
    const modal = f.element('div', { role: 'dialog' }, [modalTitle], '');
    modal.parentElement = f.document.body; f.document.body.children.push(modal);
    f.root.attributes['aria-hidden'] = 'true';
    return { modal, modalTitle };
  };
  return { ...f, header, heading, followers, following, options, open,
    setRestricted(value) { restricted = value; }, setActive(value) { active = value; } };
}

test('native opening guard re-proves the retained rail through a blank modal without generic account authority', () => {
  const f = openingFixture();
  const guard = f.context.InstaToolboxInstagramViewer.captureNativeListReadGuard(f.options);
  assert.ok(guard, 'the ordinary verified actor creates a flow-only guard');
  const { modal, modalTitle } = f.open();
  const waiting = guard.check();
  assert.equal(waiting.phase, 'opening'); assert.equal(waiting.dialog, modal);
  assert.equal('accountVerified' in waiting, false); assert.equal('accountId' in waiting, false);
  assert.equal(f.identity(), '', 'ordinary actor verification stays strict');
  assert.equal(f.context.InstaToolboxInstagramViewer.inspect({ document: f.document, location: f.location,
    session: {}, opening: true, nativeListDialog: { ...f.options, dialog: modal } }).accountVerified, false,
  'public inspect cannot opt into the private opening path');
  modalTitle.text = 'Followers';
  assert.equal(guard.check().phase, 'ready');
});

test('an expired opening reports timeout only while all fresh context predicates remain valid', () => {
  const f = openingFixture(); let clock = 499;
  f.options.deadline = 500; f.options.now = () => clock;
  const guard = f.context.InstaToolboxInstagramViewer.captureNativeListReadGuard(f.options);
  const { modalTitle } = f.open(); assert.equal(guard.check().phase, 'opening');
  clock = 500; modalTitle.text = 'Followers';
  assert.equal(guard.check().phase, 'timeout', 'a late heading cannot extend the opening budget');
  f.setRestricted(true);
  assert.equal(guard.check().phase, 'invalid', 'timeout never masks a fresh restriction');
});

function nativeSearchSkeleton(f, modal) {
  const icon = text => f.element('svg', {}, [f.element('title', {}, [], text)]);
  const close = f.element('button', { 'aria-label': 'Close' }, [icon('Close')]);
  const search = f.element('div', {}, [icon('Search'),
    f.element('input', { 'aria-label': 'Search', placeholder: 'Search' }), icon('Search')]);
  close.parentElement = modal; search.parentElement = modal; modal.children.unshift(close); modal.children.push(search);
  // HTMLElement.innerText excludes non-rendered SVG title metadata and input
  // labels; raw textContent still includes those native icon title artifacts.
  const renderedText = node => ['TITLE', 'INPUT'].includes(node.tagName) || node.style?.display === 'none'
    ? '' : node.text + node.children.map(renderedText).join('');
  Object.defineProperty(modal, 'innerText', { get: () => renderedText(modal) });
  return close;
}

function portalFixture({ reused = false } = {}) {
  const f = openingFixture();
  const portal = f.element('div');
  const attach = () => {
    if (!f.document.body.children.includes(portal)) {
      portal.parentElement = f.document.body; f.document.body.children.push(portal);
    }
  };
  if (reused) attach();
  const role = (title = '') => {
    attach();
    const modalTitle = f.element('h2', {}, [], title);
    const modal = f.element('div', { role: 'dialog', ...(title ? { 'aria-label': title } : {}) }, [modalTitle]);
    modal.parentElement = portal; portal.children = [modal]; f.root.attributes['aria-hidden'] = 'true';
    nativeSearchSkeleton(f, modal);
    return { modal, modalTitle };
  };
  const retire = modal => {
    portal.children = portal.children.filter(node => node !== modal);
    modal.parentElement = null; modal.isConnected = false;
  };
  return { ...f, portal, attach, role, retire };
}

test('one empty skeleton can hand off through a roleless gap to a typed list in the same new portal', () => {
  const f = portalFixture();
  const guard = f.context.InstaToolboxInstagramViewer.captureNativeListReadGuard(f.options);
  const first = f.role(); assert.equal(guard.check().phase, 'opening');
  f.retire(first.modal);
  const gap = guard.check();
  assert.equal(gap.phase, 'opening'); assert.equal(gap.dialog, null);
  assert.equal('accountVerified' in gap, false); assert.equal('accountId' in gap, false);
  assert.equal(f.identity(), '', 'the private gap never grants ordinary account authority');
  const second = f.role('Followers'); second.modal.style = { opacity: '0' };
  assert.equal(guard.check().phase, 'opening');
  second.modal.style.opacity = '1';
  const ready = guard.check(); assert.equal(ready.phase, 'ready'); assert.equal(ready.dialog, second.modal);
});

test('native reader observes no rows in the skeleton gap and accepts only the fully qualified successor', async () => {
  const f = portalFixture(), calls = [], phases = [];
  let qualified = false;
  const putRows = (modal, type) => {
    for (const name of type === 'followers' ? ['one.fixture', 'two.fixture'] : ['two.fixture']) {
      const row = f.element('a', { href: `/${name}/` }, [], name); row.parentElement = modal; modal.children.push(row);
    }
    modal.querySelector('[aria-label="Close"]').click = () => {
      calls.push(`close:${type}`);
      for (const node of [...f.portal.children]) f.retire(node);
      delete f.root.attributes['aria-hidden'];
    };
  };
  f.followers.click = () => {
    calls.push('open:followers'); const first = f.role();
    setTimeout(() => f.retire(first.modal), 25);
    setTimeout(() => {
      const next = f.role('Followers'); putRows(next.modal, 'followers'); qualified = true;
    }, 220);
  };
  f.following.click = () => {
    calls.push('open:following');
    // The earlier native portal persists, but this next list is typed first.
    const next = f.role('Following'); putRows(next.modal, 'following');
  };
  const result = await f.context.InstaToolboxInstagramInspector.fetchFollowerComparison({ username: 'fixture.target',
    allowNativeListFallback: true,
    fetchImpl: async () => ({ status: 404, ok: false, async json() { throw new Error('HTML'); } }),
    onNativeReadContext: value => phases.push(value?.phase || null),
    onProgress(update) {
      if (update.phase === 'native-reading') assert.equal(qualified, true, 'no row progress occurs before strict typed qualification');
    },
  });
  assert.deepEqual(calls, ['open:followers', 'close:followers', 'open:following', 'close:following']);
  assert.deepEqual(Array.from(result.followers, row => row.username), ['one.fixture', 'two.fixture']);
  assert.deepEqual(Array.from(result.following, row => row.username), ['two.fixture']);
  assert.equal(result.complete.followers, true); assert.equal(result.complete.following, true);
  assert.deepEqual(phases, ['opening', 'ready', 'opening', 'ready', null]);
});

test('a direct empty-skeleton handoff needs the same newly inserted portal', () => {
  const f = portalFixture(); const guard = f.context.InstaToolboxInstagramViewer.captureNativeListReadGuard(f.options);
  const first = f.role(); assert.equal(guard.check().phase, 'opening');
  f.retire(first.modal); const next = f.role('Followers');
  assert.equal(guard.check().phase, 'ready'); assert.equal(guard.check().dialog, next.modal);
});

test('an existing portal keeps ordinary same-role waiting and typed-first fade behavior', () => {
  for (const typedFirst of [false, true]) {
    const f = portalFixture({ reused: true });
    const guard = f.context.InstaToolboxInstagramViewer.captureNativeListReadGuard(f.options);
    const first = f.role(typedFirst ? 'Followers' : '');
    if (typedFirst) first.modal.style = { opacity: '0' };
    assert.equal(guard.check().phase, 'opening');
    first.modal.style = { opacity: '1' }; first.modalTitle.text = 'Followers';
    assert.equal(guard.check().phase, 'ready');
  }
});

for (const [name, mutate] of [
  ['an existing reused portal', () => {}],
  ['a nonempty Loading skeleton', (_f, first) => { first.modal.text = 'Loading…'; }],
  ['a skeleton with a profile link', (f, first) => {
    const row = f.element('a', { href: '/unread.fixture/' }); row.parentElement = first.modal; first.modal.children.push(row);
  }],
  ['a typed first dialog', (_f, first) => { first.modalTitle.text = 'Followers'; }],
]) {
  test(`the handoff exception cannot be captured from ${name}`, () => {
    const reused = name === 'an existing reused portal';
    const f = portalFixture({ reused }); const guard = f.context.InstaToolboxInstagramViewer.captureNativeListReadGuard(f.options);
    const first = f.role(); mutate(f, first);
    assert.ok(['opening', 'ready'].includes(guard.check().phase));
    f.retire(first.modal); f.role('Followers');
    assert.equal(guard.check().phase, 'invalid');
  });
}

for (const [name, change] of [
  ['a different portal', (f) => {
    const other = f.element('div', {}, [f.element('div', { role: 'dialog', 'aria-label': 'Followers' }, [f.element('h2', {}, [], 'Followers')])]);
    other.parentElement = f.document.body; f.document.body.children.push(other);
  }],
  ['a removed portal', (f) => { f.document.body.children = [f.root]; f.portal.isConnected = false; f.portal.parentElement = null; }],
  ['a reparented portal', (f) => {
    const wrapper = f.element('div', {}, [f.portal]); wrapper.parentElement = f.document.body;
    f.document.body.children = [f.root, wrapper];
  }],
  ['a wrong successor type', (f) => { f.role('Following'); }],
  ['an unrelated successor heading', (f) => { f.role('Confirm your identity'); }],
  ['a second simultaneous dialog', (f) => {
    const next = f.role('Followers'); const extra = f.element('div', { role: 'dialog' });
    extra.parentElement = f.portal; f.portal.children = [next.modal, extra];
  }],
  ['changed profile totals', (f) => { f.followers.text = '3 followers'; }],
  ['a replacement counter control', (f) => {
    const next = f.element('a', { role: 'link', href: '#' }, [], '2 followers');
    next.parentElement = f.header; f.header.children = [f.heading, next, f.following];
  }],
  ['changed actor evidence', (f) => { f.profile.children[0].attributes.alt = 'other.fixture\'s profile picture'; }],
  ['a replacement avatar', (f) => {
    const image = f.element('img', { alt: `${f.owner}'s profile picture` }); image.parentElement = f.profile; f.profile.children = [image];
  }],
  ['a changed profile route', (f) => { f.location.pathname = '/different.fixture/'; }],
  ['a restriction', (f) => { f.setRestricted(true); }],
  ['Stop', (f) => { f.setActive(false); }],
  ['a hidden original rail', (f) => { f.rail.style = { display: 'none' }; }],
]) {
  test(`the roleless gap refuses ${name} without granting account authority`, () => {
    const f = portalFixture(); const guard = f.context.InstaToolboxInstagramViewer.captureNativeListReadGuard(f.options);
    const first = f.role(); assert.equal(guard.check().phase, 'opening');
    f.retire(first.modal); assert.equal(guard.check().phase, 'opening');
    change(f); const outcome = guard.check();
    assert.equal(outcome.phase, 'invalid'); assert.equal(outcome.dialog, null);
    assert.equal('accountVerified' in outcome, false); assert.equal('accountId' in outcome, false);
  });
}

test('only one successor is permitted and a typed dialog can never restart the handoff', () => {
  for (const typed of [false, true]) {
    const f = portalFixture(); const guard = f.context.InstaToolboxInstagramViewer.captureNativeListReadGuard(f.options);
    const first = f.role(); assert.equal(guard.check().phase, 'opening'); f.retire(first.modal);
    const second = f.role(typed ? 'Followers' : '');
    assert.equal(guard.check().phase, typed ? 'ready' : 'opening');
    f.retire(second.modal); f.role('Followers');
    assert.equal(guard.check().phase, 'invalid');
  }
});

test('a roleless gap retains the original deadline and gives no public Viewer authority', () => {
  const f = portalFixture(); let clock = 499;
  f.options.deadline = 500; f.options.now = () => clock;
  const guard = f.context.InstaToolboxInstagramViewer.captureNativeListReadGuard(f.options);
  const first = f.role(); assert.equal(guard.check().phase, 'opening'); f.retire(first.modal);
  clock = 500; assert.equal(guard.check().phase, 'timeout');
  assert.equal(f.context.InstaToolboxInstagramViewer.inspect({ document: f.document, location: f.location, session: {},
    opening: true, openingPortal: f.portal, nativeListDialog: { ...f.options, dialog: null } }).accountVerified, false);
  f.setRestricted(true); assert.equal(guard.check().phase, 'invalid', 'deadline cannot mask a fresh restriction');
});

test('Stop during an actual reader skeleton gap accepts zero rows and never opens Following', async () => {
  const f = portalFixture(), controller = new AbortController(), calls = [], phases = [];
  f.followers.click = () => {
    calls.push('open:followers'); const first = f.role();
    setTimeout(() => f.retire(first.modal), 20); setTimeout(() => controller.abort(), 160);
  };
  f.following.click = () => calls.push('open:following');
  await assert.rejects(f.context.InstaToolboxInstagramInspector.fetchFollowerComparison({ username: 'fixture.target',
    allowNativeListFallback: true, signal: controller.signal,
    fetchImpl: async () => ({ status: 404, ok: false, async json() { throw new Error('HTML'); } }),
    onNativeReadContext: value => phases.push(value?.phase || null),
    onProgress: update => assert.notEqual(update.phase, 'native-reading'),
  }), error => error.code === 'stopped');
  assert.deepEqual(calls, ['open:followers']); assert.deepEqual(phases, ['opening', null]);
});

test('an actual reader roleless gap cannot extend the existing twenty-second opening budget', async () => {
  const f = portalFixture(), calls = [], phases = [];
  let clock = Date.now(), skeleton = null;
  const started = clock;
  f.context.Date = class extends Date { static now() { return clock; } };
  f.context.setTimeout = (callback, ms) => setTimeout(() => {
    clock += ms;
    if (skeleton?.isConnected) f.retire(skeleton);
    callback();
  }, 1);
  f.followers.click = () => { calls.push('open:followers'); skeleton = f.role().modal; };
  f.following.click = () => calls.push('open:following');
  await assert.rejects(f.context.InstaToolboxInstagramInspector.fetchFollowerComparison({ username: 'fixture.target',
    now: () => clock, maxDurationMs: 240_000, allowNativeListFallback: true,
    setTimer: setTimeout, clearTimer: clearTimeout,
    fetchImpl: async () => ({ status: 404, ok: false, async json() { throw new Error('HTML'); } }),
    onNativeReadContext: value => phases.push(value?.phase || null),
    onProgress: update => assert.notEqual(update.phase, 'native-reading'),
  }), error => error.code === 'native-list-loading-timeout');
  assert.equal(clock - started, 20_000);
  assert.deepEqual(calls, ['open:followers']); assert.deepEqual(phases, ['opening', null]);
});

test('native opening ignores unrendered Close and Search SVG titles in a titleless search skeleton', () => {
  const f = openingFixture();
  const guard = f.context.InstaToolboxInstagramViewer.captureNativeListReadGuard(f.options);
  const { modal, modalTitle } = f.open(); nativeSearchSkeleton(f, modal);
  assert.equal(modal.textContent, 'CloseSearchSearch'); assert.equal(modal.innerText, '');
  assert.equal(guard.check().phase, 'opening');
  assert.equal(f.identity(), '', 'SVG metadata does not become account authority');
  modalTitle.text = 'Followers';
  assert.equal(guard.check().phase, 'ready');
});

test('native opening still refuses unrelated rendered text beside non-rendered SVG metadata', () => {
  const f = openingFixture();
  const guard = f.context.InstaToolboxInstagramViewer.captureNativeListReadGuard(f.options);
  const { modal } = f.open(); nativeSearchSkeleton(f, modal);
  const message = f.element('div', {}, [], 'Confirm your identity to continue');
  message.parentElement = modal; modal.children.push(message);
  assert.match(modal.innerText, /Confirm your identity/);
  assert.equal(guard.check().phase, 'invalid');
});

test('native opening waits for the exact mounted dialog to fade in without relaxing ordinary Viewer visibility', () => {
  const f = openingFixture();
  const guard = f.context.InstaToolboxInstagramViewer.captureNativeListReadGuard(f.options);
  const { modal } = f.open('Followers'); nativeSearchSkeleton(f, modal); modal.style = { opacity: '0' };
  assert.equal(guard.check().phase, 'opening', 'a typed zero-opacity dialog is not ready');
  assert.equal(f.context.InstaToolboxInstagramViewer.inspect({ document: f.document, location: f.location,
    session: {}, nativeListDialog: { ...f.options, dialog: modal } }).accountVerified, false);
  modal.style.opacity = '1';
  assert.equal(guard.check().phase, 'ready');
});

test('native reader waits through a delayed native fade and SVG search skeleton before any rows or next-list navigation', async () => {
  const f = openingFixture(), calls = [], progress = [];
  let labelled = false;
  for (const [type, control] of [['followers', f.followers], ['following', f.following]]) {
    control.click = () => {
      calls.push(`open:${type}`); labelled = false;
      const { modal, modalTitle } = f.open(type === 'followers' ? 'Followers' : 'Following');
      modal.style = { opacity: '0' };
      const close = nativeSearchSkeleton(f, modal);
      assert.equal(modal.querySelectorAll('svg[aria-label*="Loading" i]').length, 0,
        'Close and Search SVG icons are not loading indicators');
      close.click = () => { calls.push(`close:${type}`); f.document.body.children = [f.root]; delete f.root.attributes['aria-hidden']; };
      setTimeout(() => {
        labelled = true; modal.style.opacity = '1'; modal.text = ''; modalTitle.text = type === 'followers' ? 'Followers' : 'Following';
        for (const name of type === 'followers' ? ['one.fixture', 'two.fixture'] : ['two.fixture']) {
          const row = f.element('a', { href: `/${name}/` }, [], name); row.parentElement = modal; modal.children.push(row);
        }
      }, 220);
    };
  }
  const result = await f.context.InstaToolboxInstagramInspector.fetchFollowerComparison({ username: 'fixture.target',
    allowNativeListFallback: true,
    fetchImpl: async () => ({ status: 404, ok: false, async json() { throw new Error('HTML'); } }),
    onProgress(value) { progress.push(value); if (value.phase === 'native-reading') assert.equal(labelled, true); },
  });
  assert.equal(result.complete.followers, true); assert.equal(result.complete.following, true);
  assert.deepEqual(calls, ['open:followers', 'close:followers', 'open:following', 'close:following']);
});

for (const [name, mutate] of [
  ['count-control replacement', f => {
    const replacement = f.element('a', { role: 'link', href: '#' }, [], '2 followers');
    replacement.parentElement = f.header; f.header.children[1] = replacement;
  }],
  ['numeric count drift', f => { f.followers.text = '3 followers'; }],
  ['actor change on the retained link', f => {
    f.profile.attributes.href = '/another.viewer/'; f.profile.children[0].attributes.alt = "another.viewer's profile picture";
  }],
  ['same-actor avatar replacement', f => {
    const picture = f.element('img', { alt: `${f.owner}'s profile picture` });
    picture.parentElement = f.profile; f.profile.children = [picture];
  }],
  ['same-actor navigation replacement', f => {
    const replacement = f.navigation(f.owner); replacement.rail.parentElement = f.root;
    f.root.children[0] = replacement.rail;
  }],
  ['profile header replacement', f => {
    const replacement = f.element('header', {}, [f.element('h2', {}, [], 'fixture.target'),
      f.element('a', { role: 'link', href: '#' }, [], '2 followers'),
      f.element('a', { role: 'link', href: '#' }, [], '1 following')]);
    replacement.parentElement = f.main; f.main.children = [replacement];
  }],
  ['route change', f => { f.location.pathname = '/another.profile/'; }],
  ['fresh session restriction', f => { f.setRestricted(true); }],
  ['hidden rail', f => { f.rail.style = { display: 'none' }; }],
  ['zero-opacity rail', f => { f.rail.style = { opacity: '0' }; }],
  ['zero-opacity profile header', f => { f.header.style = { opacity: '0' }; }],
  ['hidden native dialog', (_f, modal) => { modal.modal.style = { display: 'none' }; }],
  ['invisible native dialog', (_f, modal) => { modal.modal.style = { visibility: 'hidden' }; }],
  ['aria-hidden native dialog', (_f, modal) => { modal.modal.attributes['aria-hidden'] = 'true'; }],
  ['zero-opacity native dialog ancestor', (f, modal) => {
    const wrapper = f.element('div', {}, [modal.modal]); wrapper.style = { opacity: '0' };
    wrapper.parentElement = f.document.body; f.document.body.children[1] = wrapper;
  }],
  ['additional zero-opacity dialog', f => { f.open().modal.style = { opacity: '0' }; }],
  ['second visible dialog', f => { f.open(); }],
  ['replacement dialog', f => {
    f.document.body.children = [f.root]; f.open();
  }],
  ['unrelated explicit heading', (_f, modal) => { modal.modalTitle.text = 'Reactions'; }],
  ['wrong list heading', (_f, modal) => { modal.modalTitle.text = 'Following'; }],
  ['new backdrop wrapper', f => {
    const wrapper = f.element('div', { 'aria-hidden': 'true' }, [f.root]);
    wrapper.parentElement = f.document.body; delete f.root.attributes['aria-hidden'];
    f.document.body.children[0] = wrapper;
  }],
]) {
  test(`native opening refuses ${name} before rows can be qualified`, () => {
    const f = openingFixture();
    const guard = f.context.InstaToolboxInstagramViewer.captureNativeListReadGuard(f.options);
    const modal = f.open(); assert.equal(guard.check().phase, 'opening');
    mutate(f, modal);
    assert.equal(guard.check().phase, 'invalid');
    assert.equal(guard.check().phase, 'invalid', 'refusal is permanent for this one read');
  });
}

for (const [name, change] of [
  ['an initially unverified actor', f => { f.profile.attributes.href = '/another.viewer/'; }],
  ['an existing blank native dialog', f => { f.open(); }],
  ['an existing mounted zero-opacity dialog', f => {
    const { modal } = f.open(); modal.style = { opacity: '0' }; delete f.root.attributes['aria-hidden'];
  }],
  ['a restricted session', f => { f.setRestricted(true); }],
  ['an expired or cancelled flow', f => { f.options.isActive = () => false; }],
]) {
  test(`native opening cannot be captured with ${name}`, () => {
    const f = openingFixture(); change(f);
    assert.equal(f.context.InstaToolboxInstagramViewer.captureNativeListReadGuard(f.options), null);
  });
}

test('native opening Stop clears its ephemeral context without observing rows or opening Following', async () => {
  const f = openingFixture(), controller = new AbortController(), phases = [], calls = [];
  f.followers.click = () => {
    calls.push('open:followers'); f.open(); setTimeout(() => controller.abort(), 30);
  };
  f.following.click = () => { calls.push('open:following'); };
  await assert.rejects(f.context.InstaToolboxInstagramInspector.fetchFollowerComparison({ username: 'fixture.target',
    signal: controller.signal, maxDurationMs: 240_000, allowNativeListFallback: true,
    fetchImpl: async () => ({ status: 404, ok: false, async json() { throw new Error('HTML'); } }),
    onNativeReadContext(value) { phases.push(value?.phase || null); },
    onProgress(value) { assert.notEqual(value.phase, 'native-reading'); },
  }), error => error.code === 'stopped');
  assert.deepEqual(calls, ['open:followers']); assert.deepEqual(phases, ['opening', null]);
});

test('native blank opening consumes only the existing twenty-second initial readiness budget', async () => {
  const f = openingFixture(), calls = [], phases = [];
  let clock = Date.now();
  f.context.Date = class extends Date { static now() { return clock; } };
  f.context.setTimeout = (callback, ms) => setTimeout(() => { clock += ms; callback(); }, 1);
  f.followers.click = () => { calls.push('open:followers'); f.open(); };
  f.following.click = () => { calls.push('open:following'); };
  const started = clock;
  await assert.rejects(f.context.InstaToolboxInstagramInspector.fetchFollowerComparison({ username: 'fixture.target',
    now: () => clock, maxDurationMs: 240_000, allowNativeListFallback: true,
    setTimer: setTimeout, clearTimer: clearTimeout,
    fetchImpl: async () => ({ status: 404, ok: false, async json() { throw new Error('HTML'); } }),
    onNativeReadContext(value) { phases.push(value?.phase || null); },
    onProgress(value) { assert.notEqual(value.phase, 'native-reading'); },
  }), error => error.code === 'native-list-loading-timeout');
  assert.equal(clock - started, 20_000);
  assert.deepEqual(calls, ['open:followers']); assert.deepEqual(phases, ['opening', null]);
});

test('a late list heading shares the opening deadline with row readiness instead of receiving another twenty seconds', async () => {
  const f = openingFixture(), calls = [];
  let clock = Date.now(), modalTitle;
  const started = clock;
  f.context.Date = class extends Date { static now() { return clock; } };
  f.context.setTimeout = (callback, ms) => setTimeout(() => {
    clock += ms;
    if (clock - started >= 19_000 && modalTitle) modalTitle.text = 'Followers';
    callback();
  }, 1);
  f.followers.click = () => { calls.push('open:followers'); ({ modalTitle } = f.open()); };
  f.following.click = () => { calls.push('open:following'); };
  await assert.rejects(f.context.InstaToolboxInstagramInspector.fetchFollowerComparison({ username: 'fixture.target',
    now: () => clock, maxDurationMs: 240_000, allowNativeListFallback: true,
    setTimer: setTimeout, clearTimer: clearTimeout,
    fetchImpl: async () => ({ status: 404, ok: false, async json() { throw new Error('HTML'); } }),
  }), error => error.code === 'native-list-loading-timeout');
  assert.equal(clock - started, 20_000);
  assert.deepEqual(calls, ['open:followers']);
});

function modalNavigationFixture(size, { hiddenBackdrop = true } = {}) {
  const f = openingFixture();
  if (hiddenBackdrop) f.root.attributes['aria-hidden'] = 'true';
  const rows = Array.from({ length: size }, (_, index) => {
    const owner = 'fixture.person' + index;
    return f.element('div', {}, [f.element('a', { role: 'link', href: '/' + owner + '/' }, [
      f.element('img', { alt: owner + "'s profile picture" }),
    ])]);
  });
  const list = f.element('div', {}, rows);
  const modal = f.element('div', { role: 'dialog', 'aria-label': 'Followers' }, [f.element('h2', {}, [], 'Followers'), list]);
  modal.parentElement = f.document.body; f.document.body.children.push(modal);
  let navigationRescans = 0;
  for (const node of [list, modal]) {
    const query = node.querySelectorAll;
    node.querySelectorAll = function (selector) {
      if (selector === 'a[href]') navigationRescans += 1;
      return query.call(this, selector);
    };
  }
  return { ...f, modal, navigationRescans: () => navigationRescans };
}

test('account navigation does not repeatedly rescan large native-dialog profile rows', () => {
  for (const hiddenBackdrop of [true, false]) {
    const f = modalNavigationFixture(198, { hiddenBackdrop });
    const value = f.context.InstaToolboxInstagramViewer.inspect({ document: f.document, location: f.location, session: {} });
    assert.equal(value.accountVerified, !hiddenBackdrop, 'ordinary visible navigation remains the only actor proof');
    assert.ok(f.navigationRescans() <= 1, 'dialog contents are not searched once per profile avatar');
  }
});

test('large dialog filtering preserves explicitly scoped native-list account proof', () => {
  const f = modalNavigationFixture(198);
  f.followers.text = '198 followers';
  const value = f.context.InstaToolboxInstagramViewer.inspect({ document: f.document, location: f.location,
    session: {}, nativeListDialog: { profileHeader: f.header, username: 'fixture.target', listType: 'followers', dialog: f.modal } });
  assert.equal(value.accountVerified, true); assert.equal(value.accountId, f.owner);
  assert.ok(f.navigationRescans() <= 1, 'qualified backdrop proof does not require crawling dialog avatars');
});
