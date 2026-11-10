import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const labels = await readFile(new URL('../extension/action-labels.js', import.meta.url), 'utf8');
const source = await readFile(new URL('../extension/content-instagram.js', import.meta.url), 'utf8');

function fixture({ pathname = '/fixture_owner/', counts = { followers: 2, following: 1 },
  rows = { followers: ['fixture_one', 'fixture_two'], following: ['fixture_two'] }, onOpen, onClose,
  recycled = false, fastSettle = false, fakeClock = false } = {}) {
  const calls = [], requests = [], progress = [];
  let active = null, owner = 'fixture_viewer', headers = 1, hidden = false, counterVisible = true, bodyText = '';
  const location = { origin: 'https://www.instagram.com', pathname, href: `https://www.instagram.com${pathname}` };
  const node = (text, attrs = {}) => ({ textContent: text, isConnected: true,
    getAttribute: name => attrs[name] ?? null, getClientRects: () => [{}], closest: () => null,
    querySelectorAll: () => [], querySelector: () => null });
  const identity = node('fixture_owner');
  const controls = ['followers', 'following'].map(type => {
    const control = node('', { href: `/fixture_owner/${type}/`, role: 'link' });
    Object.defineProperty(control, 'textContent', { get: () => counterVisible ? `${counts[type]} ${type}` : '' });
    control.click = () => {
      calls.push(`open:${type}`);
      const modal = node(type === 'followers' ? 'Followers' : 'Following', { role: 'dialog' });
      const scroller = { ...node(''), isScroller: true, clientHeight: 100, scrollHeight: rows[type].length * 50, _top: 0,
        get scrollTop() { return this._top; }, set scrollTop(value) { this._top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); } };
      const close = node('', { 'aria-label': 'Close' });
      close.click = () => { calls.push(`close:${type}`); active = null; onClose?.(type, api); };
      modal.querySelectorAll = selector => selector === 'a[href^="/"]'
        ? (recycled ? rows[type].slice(Math.floor(scroller.scrollTop / 50), Math.floor(scroller.scrollTop / 50) + 3) : rows[type])
          .map(name => node(name, { href: `/${name}/` }))
        : selector === 'button, [role="button"]' ? [close] : recycled && selector === 'div, ul, section' ? [scroller] : [];
      active = modal; onOpen?.(type, api);
    };
    return control;
  });
  const header = node('fixture_owner profile');
  header.contains = element => element === identity || controls.includes(element);
  header.querySelectorAll = selector => selector === 'a[role="link"], a[href="#"]' ? controls : [identity, ...controls];
  const document = { body: { get innerText() { return bodyText; } }, querySelector: () => null,
    querySelectorAll: selector => selector === 'main header' ? Array(headers).fill(header)
      : selector === '[role="dialog"]' ? active ? [active] : []
        : selector === 'a[role="link"], a[href="#"]' ? controls : [] };
  let clock = Date.now();
  class Clock extends Date { static now() { return clock; } }
  const context = vm.createContext({ URL, AbortController, document, location, clearTimeout, Date: fakeClock ? Clock : Date,
    setTimeout: (callback, ms) => setTimeout(() => { if (fakeClock) clock += ms; callback(); }, fastSettle ? Math.min(ms, 1) : ms),
    getComputedStyle: element => ({ display: element === header && hidden ? 'none' : element.style?.display || 'block',
      visibility: element.style?.visibility || 'visible', opacity: element.style?.opacity ?? '1',
      overflowY: element.isScroller ? 'auto' : 'visible' }),
    InstaToolboxInstagramViewer: { inspect: () => ({ accountVerified: Boolean(owner), accountId: owner }) },
    chrome: { runtime: { onMessage: { addListener() {} } } } });
  vm.runInContext(labels, context); vm.runInContext(source, context);
  const api = { context, controls, location, counts, calls, requests, progress,
    set owner(value) { owner = value; }, set headers(value) { headers = value; }, set hidden(value) { hidden = value; },
    set counterVisible(value) { counterVisible = value; }, set bodyText(value) { bodyText = value; },
    get modal() { return active; }, set modal(value) { active = value; },
    async run(options = {}) {
      return context.InstaToolboxInstagramInspector.fetchFollowerComparison({ username: 'fixture_owner',
        allowNativeListFallback: true, setTimer: setTimeout, onProgress: event => progress.push(event),
        fetchImpl: async input => { requests.push(new URL(input).pathname); return { ok: false, status: 404,
          async json() { throw new SyntaxError('HTML error page'); } }; }, ...options });
    } };
  return api;
}

test('retired lookup chain reads only exact native owner lists with honest DOM provenance', async () => {
  const f = fixture(); const result = await f.run();
  assert.deepEqual(f.requests, ['/api/v1/web/search/topsearch/', '/api/v1/users/web_profile_info/']);
  assert.deepEqual(f.calls, ['open:followers', 'close:followers', 'open:following', 'close:following']);
  assert.equal(result.source, 'list-dialog');
  assert.equal('subjectInstagramId' in result, false); assert.equal('userId' in result, false);
  assert.deepEqual({ ...result.complete }, { followers: true, following: true });
  assert.deepEqual({ ...result.verified }, { followers: true, following: true });
  assert.deepEqual({ ...result.pages }, { followers: null, following: null });
  assert.equal(result.reasons.followers, 'native-list-complete');
  assert.ok(result.followers.every(row => row.source === 'extension-scrolled-dom' && !('instagramId' in row)));
  assert.ok(f.progress.some(event => event.phase === 'native-reading' && event.listType === 'followers' && event.found === 2));
  const engine = f.context.InstaToolboxInstagramInspector;
  const workspace = { ...result, subjectUsername: result.username, source: { followers: 'list-dialog', following: 'list-dialog' } };
  const record = engine.followerComparisonRecord(workspace, {});
  assert.equal(record.partial, false); assert.equal(record.source.followers, 'list-dialog');
  assert.equal(record.pages.followers, null);
  assert.match(engine.followerComparisonReport(workspace, {}), /Instagram list-dialog capture/);
});

test('fallback is opt-in and requires both explicit lookup retirement statuses', async () => {
  const disabled = fixture(); await assert.rejects(disabled.run({ allowNativeListFallback: false }), error => error.httpStatus === 404);
  assert.equal(disabled.calls.length, 0);
  for (const status of [401, 403, 429, 500]) {
    const f = fixture(); let attempt = 0;
    await assert.rejects(f.run({ fetchImpl: async () => ({ ok: false, status: ++attempt === 1 ? 404 : status,
      async json() { throw new Error('HTML'); } }) }));
    assert.equal(f.calls.length, 0, `metadata HTTP ${status} cannot enable native reads`);
  }
  const gone = fixture();
  const result = await gone.run({ fetchImpl: async () => ({ ok: false, status: 410, async json() { return {}; } }) });
  assert.equal(result.complete.following, true);
});

test('non-current profile recovery and unsafe native contexts cannot open a list', async () => {
  const other = fixture({ pathname: '/other_fixture/' });
  await assert.rejects(other.run(), error => error.code === 'native-profile-required' && /Open @fixture_owner/.test(error.message));
  assert.equal(other.calls.length, 0);
  for (const configure of [f => { f.headers = 2; }, f => { f.hidden = true; }, f => { f.owner = ''; },
    f => { f.counterVisible = false; }, f => { f.modal = { isConnected: true, textContent: 'Unexpected',
      getAttribute: () => null, getClientRects: () => [{}] }; }]) {
    const f = fixture(); configure(f); await assert.rejects(f.run()); assert.equal(f.calls.length, 0);
  }
});

test('empty lists require fresh zero totals and changed or missing final totals remain partial', async () => {
  const empty = fixture({ counts: { followers: 0, following: 0 }, rows: { followers: [], following: [] } });
  assert.deepEqual({ ...(await empty.run()).complete }, { followers: true, following: true });
  const changed = fixture({ onClose(type, f) { if (type === 'following') f.counts.followers += 1; } });
  const changedResult = await changed.run();
  assert.equal(changedResult.complete.followers, false); assert.equal(changedResult.reasons.followers, 'count-changed');
  const missing = fixture({ onClose(type, f) { if (type === 'following') f.counterVisible = false; } });
  const missingResult = await missing.run();
  assert.equal(missingResult.complete.followers, false); assert.equal(missingResult.complete.following, false);
  assert.equal(missingResult.reasons.followers, 'count-unverified');
});

test('Stop retains scoped partial rows without opening the next list or further native clicks', async () => {
  const controller = new AbortController(); const f = fixture();
  await assert.rejects(f.run({ signal: controller.signal, onProgress(event) {
    if (event.phase === 'native-reading') controller.abort();
  } }), error => {
    assert.equal(error.code, 'stopped'); assert.equal(error.partialResult.source, 'list-dialog');
    assert.equal(error.partialResult.followers.length, 2); assert.equal(error.partialResult.following.length, 0);
    assert.equal(error.partialResult.verified.following, false);
    assert.equal(error.partialResult.complete.followers, false); assert.equal(error.partialResult.reasons.followers, 'stopped');
    return true;
  });
  assert.deepEqual(f.calls, ['open:followers']);
  const between = new AbortController();
  const g = fixture({ onClose(type) { if (type === 'followers') between.abort(); } });
  await assert.rejects(g.run({ signal: between.signal }), error => error.code === 'stopped' && error.partialResult.followers.length === 2);
  assert.deepEqual(g.calls, ['open:followers', 'close:followers']);
});

test('wrong modal, owner switch, and route switch prevent the following-list click', async () => {
  for (const change of [f => { f.modal.textContent = 'Following'; }, f => { f.owner = 'other_viewer'; },
    f => { f.location.pathname = '/other_fixture/'; }]) {
    const f = fixture({ onOpen(type, api) { if (type === 'followers') change(api); } });
    await assert.rejects(f.run()); assert.deepEqual(f.calls, ['open:followers']);
  }
});

test('modal replacement and viewer/restriction changes stop before any foreign rows can be harvested', async () => {
  for (const mutate of [f => { f.owner = 'other_viewer'; }, f => { f.bodyText = 'We restrict certain activity'; },
    f => { f.modal = { ...f.modal, querySelectorAll(selector) {
      return selector === 'a[href^="/"]' ? [{ textContent: 'foreign_fixture', getAttribute: () => '/foreign_fixture/' }] : [];
    } }; }]) {
    const f = fixture();
    await assert.rejects(f.run({ onProgress(event) { if (event.phase === 'native-reading') mutate(f); } }), error => {
      assert.equal(error.partialResult.followers.length, 2);
      assert.ok(error.partialResult.followers.every(row => row.username !== 'foreign_fixture'));
      assert.equal(error.partialResult.complete.followers, false); return true;
    });
    assert.deepEqual(f.calls, ['open:followers']);
  }
});

test('Stop before opening or while the native modal opens never reads or closes another surface', async () => {
  for (const when of ['ready', 'opening']) {
    const controller = new AbortController();
    const f = fixture({ onOpen() { if (when === 'opening') controller.abort(); } });
    await assert.rejects(f.run({ signal: controller.signal,
      onProgress(event) { if (when === 'ready' && event.phase === 'native-lists') controller.abort(); } }), error => {
      assert.equal(error.code, 'stopped'); assert.equal(error.partialResult, undefined); return true;
    });
    assert.deepEqual(f.calls, when === 'ready' ? [] : ['open:followers']);
  }
});

test('a native account limit retains bounded rows and cannot claim complete', async () => {
  const f = fixture(); const result = await f.run({ maxAccounts: 1 });
  assert.equal(result.followers.length, 1); assert.equal(result.complete.followers, false);
  assert.equal(result.reasons.followers, 'account-limit');
  assert.equal(result.complete.following, false, 'hitting the bound never claims completeness from a matching count');
});

test('primary native fallback reads recycled windows through the strict collector with incremental progress', async () => {
  const names = Array.from({ length: 17 }, (_, index) => `recycled_fixture_${index}`);
  const f = fixture({ counts: { followers: 17, following: 1 },
    rows: { followers: names, following: [names[0]] }, recycled: true, fastSettle: true });
  const result = await f.run();
  assert.equal(result.followers.length, 17); assert.equal(new Set(result.followers.map(row => row.username)).size, 17);
  assert.equal(result.complete.followers, true); assert.equal(result.complete.following, true);
  const counts = f.progress.filter(event => event.phase === 'native-reading' && event.listType === 'followers').map(event => event.found);
  assert.equal(counts[0], 3); assert.equal(counts.at(-1), 17); assert.ok(counts.length > 3);
});

test('native Stop aborts an outstanding collector settle promptly and preserves only its original window', async () => {
  const controller = new AbortController(), names = Array.from({ length: 17 }, (_, index) => `waiting_fixture_${index}`);
  const f = fixture({ counts: { followers: 17, following: 1 }, rows: { followers: names, following: [names[0]] }, recycled: true });
  const started = Date.now(); let timer;
  await assert.rejects(f.run({ signal: controller.signal, onProgress(event) {
    if (event.phase === 'native-reading' && !timer) timer = setTimeout(() => controller.abort(), 10);
  } }), error => {
    assert.equal(error.code, 'stopped'); assert.equal(error.partialResult.followers.length, 3); return true;
  });
  assert.ok(Date.now() - started < 250, 'Stop must interrupt the native 500ms settle');
  assert.deepEqual(f.calls, ['open:followers']);
});

test('native checker waits for delayed first rows and a later scroll owner before advancing lists', async () => {
  const names = Array.from({ length: 17 }, (_, index) => `delayed_fixture_${index}`);
  const timers = [];
  const f = fixture({ counts: { followers: 17, following: 1 }, rows: { followers: names, following: [names[0]] },
    recycled: true, fastSettle: true,
    onOpen(type, api) {
      if (type !== 'followers') return;
      const modal = api.modal, original = modal.querySelectorAll;
      let rowsReady = false, scrollerReady = false;
      modal.querySelectorAll = selector => selector === 'a[href^="/"]' && !rowsReady ? []
        : selector === 'div, ul, section' && !scrollerReady ? [] : original(selector);
      timers.push(setTimeout(() => { rowsReady = true; }, 25));
      timers.push(setTimeout(() => { scrollerReady = true; }, 80));
    } });
  try {
    const result = await f.run();
    assert.equal(result.followers.length, 17, 'a mounted empty modal must not become a zero-row finished read');
    assert.equal(result.complete.followers, true); assert.equal(result.complete.following, true);
    assert.ok(f.progress.some(event => event.listType === 'followers' && event.found === 3));
  } finally { timers.forEach(clearTimeout); }
});

function initialLoadingFixture({ counts = { followers: 2, following: 1 },
  rows = { followers: ['loading_fixture_one', 'loading_fixture_two'], following: ['loading_fixture_two'] },
  hiddenLoader = false, loaderVisible = true, hideRows = false, fakeClock = false, onOpen = null } = {}) {
  let showRows = !hideRows, loading = loaderVisible;
  const loader = { isConnected: true, getClientRects: () => [{}], getAttribute: () => null,
    style: hiddenLoader ? { display: 'none' } : {} };
  const f = fixture({ counts, rows, fastSettle: true, fakeClock,
    onOpen(type, api) {
      if (type !== 'followers') return;
      const modal = api.modal, original = modal.querySelectorAll;
      modal.querySelectorAll = selector => selector.includes('[role="progressbar"]') ? loading ? [loader] : []
        : selector === 'a[href^="/"]' && !showRows ? [] : original(selector);
      onOpen?.(api);
    } });
  f.showRows = () => { showRows = true; };
  f.finishLoading = () => { loading = false; };
  return f;
}

test('an exact fixed list waits for its rendered loader and verified zero remains genuinely empty', async () => {
  for (const empty of [false, true]) {
    const f = initialLoadingFixture(empty ? { counts: { followers: 0, following: 0 }, rows: { followers: [], following: [] } } : {});
    const pending = f.run();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(f.calls, ['open:followers'], 'a visible loading indicator must prevent advancing to Following');
    f.finishLoading();
    const result = await pending;
    assert.equal(result.followers.length, empty ? 0 : 2);
    assert.equal(result.complete.followers, true); assert.equal(result.complete.following, true);
  }
});

test('a hidden stale loader cannot hold an otherwise exact native list until timeout', async () => {
  const f = initialLoadingFixture({ hiddenLoader: true, fakeClock: true });
  const result = await f.run();
  assert.equal(result.followers.length, 2); assert.equal(result.complete.followers, true);
  assert.deepEqual(f.calls, ['open:followers', 'close:followers', 'open:following', 'close:following']);
});

test('initial loading timeout never opens Following and retains scoped rows with its explicit reason', async () => {
  for (const hideRows of [false, true]) {
    const f = initialLoadingFixture({ fakeClock: true, hideRows });
    await assert.rejects(f.run(), error => {
      assert.equal(error.code, 'native-list-loading-timeout');
      assert.match(error.message, /followers list is still loading.*finish loading, close it, then retry the read from the same profile/);
      if (hideRows) assert.equal(error.partialResult, undefined);
      else {
        assert.equal(error.partialResult.followers.length, 2);
        assert.equal(error.partialResult.complete.followers, false); assert.equal(error.partialResult.complete.following, false);
        assert.equal(error.partialResult.verified.following, false);
        assert.equal(error.partialResult.reasons.followers, 'native-list-loading-timeout');
        const diagnostics = f.context.InstaToolboxInstagramInspector.normalizeFollowerDiagnostics(error.partialResult);
        assert.equal(diagnostics.reasons.followers, 'native-list-loading-timeout');
      }
      return true;
    });
    assert.deepEqual(f.calls, ['open:followers']);
  }
});

test('Stop and native context drift during initial loading preserve rows without later native clicks', async () => {
  for (const kind of ['stop', 'profile', 'dialog']) {
    const controller = new AbortController(); const f = initialLoadingFixture();
    let mutation;
    try {
      const pending = f.run({ signal: controller.signal, onProgress(event) {
        if (event.phase !== 'native-reading' || !event.found || mutation) return;
        mutation = setTimeout(() => {
          if (kind === 'stop') controller.abort();
          else if (kind === 'profile') f.location.pathname = '/foreign_fixture/';
          else f.modal = { ...f.modal };
        }, 10);
      } });
      await assert.rejects(pending, error => {
        assert.equal(error.partialResult.followers.length, 2);
        assert.equal(error.partialResult.complete.followers, false);
        assert.equal(error.partialResult.following.length, 0);
        if (kind === 'stop') assert.equal(error.code, 'stopped');
        return true;
      });
      assert.deepEqual(f.calls, ['open:followers']);
    } finally { clearTimeout(mutation); }
  }
});
