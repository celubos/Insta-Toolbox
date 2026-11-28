(() => {
  'use strict';
  if (globalThis.InstaToolboxInstagramViewer) return;
  const origin = 'https://www.instagram.com';
  const username = (value) => {
    const normalized = String(value || '').trim().toLowerCase();
    return /^[a-z0-9._]{1,30}$/.test(normalized) ? normalized : null;
  };
  function accountKey(value) {
    const normalized = username(value);
    if (!normalized) return null;
    return `iguser-v1-${[...normalized].map((character) => character.charCodeAt(0).toString(16).padStart(2, '0')).join('')}`;
  }
  const visible = (node) => Boolean(node?.isConnected
    && !node.closest?.('[hidden], [aria-hidden="true"]')
    && node.getClientRects?.().length);
  function pathOf(link) {
    try {
      const url = new URL(link.getAttribute('href'), origin);
      return url.origin === origin && !url.username && !url.password
        && !url.search && !url.hash ? url.pathname : '';
    } catch { return ''; }
  }
  function nativeListBackdrop({ document, location, context }, { capture = false, opening = false, openingPortal = null } = {}) {
    const owner = username(context?.username), type = context?.listType;
    const header = context?.profileHeader, dialog = context?.dialog;
    const gap = !capture && opening && openingPortal && dialog === null;
    const surface = gap ? openingPortal : dialog;
    if (!owner || !['followers', 'following'].includes(type)
      || !new RegExp(`^/${owner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/?$`, 'i').test(location.pathname)) return null;
    const backdrop = header?.closest?.('[aria-hidden="true"]');
    const rendered = (node, allowed = null, fadingDialog = null) => {
      if (!node?.isConnected || !node.getClientRects?.().length || typeof getComputedStyle !== 'function') return false;
      for (let parent = node; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (parent.hidden || (parent.getAttribute?.('aria-hidden') === 'true' && parent !== allowed)
          || style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility)
          || (style.opacity !== undefined && style.opacity !== '' && Number(style.opacity) === 0
            && parent !== fadingDialog)) return false;
      }
      return true;
    };
    if (capture ? backdrop || !rendered(header) : !backdrop || backdrop === header
      || backdrop.contains(surface) || !rendered(header, backdrop) || !rendered(surface, null, opening && !gap ? dialog : null)) return null;
    const dialogs = [...document.querySelectorAll('[role="dialog"]')]
      .filter(node => rendered(node, null, capture || opening ? node : null));
    if (capture ? dialogs.length !== 0 : gap ? dialogs.length !== 0 : dialogs.length !== 1 || dialogs[0] !== dialog) return null;
    const labels = capture || gap ? [] : [dialog.getAttribute('aria-label'),
      ...[...dialog.querySelectorAll('[role="heading"], h1, h2')]
        .filter(node => rendered(node, null, opening ? dialog : null)).map(node => node.textContent),
      String((opening && typeof dialog.innerText === 'string' ? dialog.innerText : dialog.textContent) || '')
        .split(/\r?\n/).map(line => line.trim()).find(Boolean)];
    const types = new Set(labels.map(label => String(label || '').normalize('NFKC').trim().toLowerCase().match(/^(followers|following)(?:\s|$)/)?.[1]).filter(Boolean));
    if (!capture && (types.size > 1 || types.size === 1 && !types.has(type))) return null;
    const typed = types.size === 1 && types.has(type);
    const ready = !gap && typed && (!opening || rendered(dialog));
    const empty = !capture && !gap && labels.every(label => !String(label || '').normalize('NFKC').trim())
      && !dialog.querySelector('a[href], main, article');
    if (!capture && !gap && (opening || !ready) && (!opening || (typed ? labels.slice(0, -1) : labels).some(label => {
      const text = String(label || '').normalize('NFKC').trim();
      return text && !/^loading[.\s\u2026]*$/i.test(text)
        && !new RegExp(`^${type}(?:\\s|$)`, 'i').test(text);
    }))) return null;
    const headers = [...document.querySelectorAll('main header')].filter(node => rendered(node, backdrop));
    if (headers.length !== 1 || headers[0] !== header
      || ![...header.querySelectorAll('a[href], h1, h2, [role="heading"]')]
        .some(node => rendered(node, backdrop) && username(node.textContent) === owner)) return null;
    const countControls = [], totals = [];
    for (const listType of ['followers', 'following']) {
      const controls = [...header.querySelectorAll('a[role="link"], a[href="#"]')].filter(node => {
        if (!rendered(node, backdrop) || !new RegExp(`\\s${listType}$`, 'i').test(String(node.textContent || '').trim())) return false;
        const href = node.getAttribute('href'), path = pathOf(node).replace(/\/+$/, '').toLowerCase();
        return href === '#' || [`/${owner}`, `/${owner}/${listType}`].includes(path);
      });
      if (controls.length !== 1) return null;
      const control = controls[0], counts = new Set();
      const title = control.querySelector?.('[title]')?.getAttribute('title');
      for (const value of [control.getAttribute('title'), control.textContent, title ? `${title} ${listType}` : '']) {
        const match = String(value || '').normalize('NFKC').replace(/[\u00a0\u202f]/g, ' ').trim().toLowerCase()
          .match(/^([0-9][0-9., ]*)\s+(followers|following)$/);
        if (!match || match[2] !== listType || !/^(?:\d+|\d{1,3}([,. ])\d{3}(?:\1\d{3})*)$/.test(match[1])) continue;
        const count = Number(match[1].replace(/\D/g, ''));
        if (Number.isSafeInteger(count)) counts.add(count);
      }
      if (counts.size !== 1) return null;
      countControls.push(control); totals.push([...counts][0]);
    }
    return { backdrop, controls: countControls, totals, ready, typed, empty, shown: node => rendered(node, backdrop)
      && node.closest?.('[aria-hidden="true"]') === backdrop };
  }
  function inspectCurrent({ document = globalThis.document, location = globalThis.location,
    session = globalThis.InstaToolboxInstagramInspector?.inspectSession?.() || {},
    reactionDialog = false, nativeListDialog = null } = {}, opening = false, evidence = null, openingPortal = null) {
    const unavailable = { accountVerified: false, usable: false, accountId: null, threadId: null };
    if (location?.origin !== origin) return { ...unavailable, reason: 'instagram-origin-required' };
    const threadId = String(location.pathname).match(/^\/direct\/t\/([0-9]+)\/?$/)?.[1] || null;
    const restriction = session.sessionExpired || session.challenge || session.actionBlocked || session.rateLimited;
    if (restriction) return { ...unavailable, threadId, restriction: true, reason: 'instagram-restricted' };
    const nativeBackdrop = nativeListDialog === null ? null
      : nativeListBackdrop({ document, location, context: nativeListDialog }, { opening, openingPortal });
    if (nativeListDialog !== null && !nativeBackdrop) return { ...unavailable, threadId, reason: 'native-list-context-unavailable' };
    const rawLists = [...document.querySelectorAll('[aria-label="Thread list"]')];
    const dialogs = reactionDialog ? [...document.querySelectorAll('[role="dialog"]')]
      .filter(visible).filter(node => [...node.querySelectorAll('h1, h2, h3, [role="heading"]')]
        .some(heading => String(heading.textContent || '').trim() === 'Reactions')) : [];
    const shown = (node) => {
      if (nativeBackdrop) return nativeBackdrop.shown(node);
      if (visible(node)) return true;
      if (dialogs.length !== 1 || !node?.isConnected || node.closest?.('[hidden]')
        || !node.getClientRects?.().length) return false;
      // A native modal can hide the whole app from assistive technology while
      // leaving its account controls mounted. Re-read those same controls;
      // never retain an account name across an actual switch or disappearance.
      const backdrop = node.closest?.('[aria-hidden="true"]');
      return Boolean(backdrop && backdrop !== node && !backdrop.contains(dialogs[0])
        && rawLists.some(list => backdrop.contains(list)));
    };
    const lists = rawLists.filter(shown);
    if (lists.length > 1 || (threadId && lists.length !== 1)) return { ...unavailable, threadId, reason: 'account-picker-unavailable' };
    const list = lists[0];
    const headings = [...(list?.querySelectorAll('h2') || [])].filter((heading) => {
      const picker = heading.closest('[role="button"][tabindex="0"]');
      return shown(heading) && picker && list.contains(picker) && shown(picker);
    });
    if (list && headings.length !== 1) return { ...unavailable, threadId, reason: 'account-picker-ambiguous' };
    const pickerAccount = list ? username(headings[0].textContent) : null;
    if (list && !pickerAccount) return { ...unavailable, threadId, reason: 'account-name-unavailable' };
    const navigation = new Map();
    const profiles = [...document.querySelectorAll('a[role="link"][href]')].filter((link) => {
      // Dialog profile rows are content, not account navigation. Reject them
      // before ancestor searches so growing native lists do not cause quadratic work.
      if (link.closest?.('[role="dialog"]') || !shown(link) || list?.contains(link)
        || link.getAttribute('aria-label')?.startsWith('Open the profile page of')) return false;
      const match = pathOf(link).match(/^\/([a-z0-9._]+)\/?$/i);
      const accountId = match && username(match[1]);
      if (!accountId || (pickerAccount && accountId !== pickerAccount)) return false;
      const pictures = [...link.querySelectorAll('img')].filter(shown);
      if (pictures.length !== 1
        || String(pictures[0].getAttribute('alt')).toLowerCase() !== `${accountId}'s profile picture`) return false;
      for (let rail = link.parentElement; rail && rail !== document.body; rail = rail.parentElement) {
        if ((list && rail.contains(list)) || rail.querySelector?.('main, article, [data-pagelet="IGDMessagesList"]')) return false;
        const links = [...rail.querySelectorAll('a[href]')].filter(shown);
        const paths = new Set(links.map(pathOf));
        const messages = links.some(node => /^\/direct\/t\/\d+\/?$/.test(pathOf(node))
          && (node.getAttribute('aria-label') === 'Messages' || node.querySelector?.('[aria-label="Messages"]')));
        if (paths.has('/') && (paths.has('/reels/') || paths.has('/reels'))
          && (paths.has('/direct/inbox/') || paths.has('/direct/inbox') || messages)) {
          navigation.set(link, { rail, picture: pictures[0] }); return true;
        }
      }
      return false;
    });
    // Instagram sometimes nests a profile link around another identical link.
    // That is one control, not two independent account identities.
    const profileControls = profiles.filter(link => !profiles.some(other =>
      other !== link && other.contains(link) && pathOf(other) === pathOf(link)));
    if (profileControls.length !== 1) return { ...unavailable, threadId, reason: 'account-navigation-unavailable' };
    if (evidence) Object.assign(evidence, { profile: profileControls[0], ...navigation.get(profileControls[0]) });
    const accountId = pickerAccount || username(pathOf(profileControls[0]).split('/')[1]);
    return { accountVerified: true, accountId, threadId, usable: Boolean(threadId),
      accountKey: accountKey(accountId), identityKind: 'verified-viewer-username',
      restriction: false, evidence: list ? 'visible-account-picker-and-navigation' : 'visible-account-navigation' };
  }
  const inspect = options => inspectCurrent(options);

  // This capability permits waiting for one native read's opening surface.
  // It does not return an account identity or authorize storage or actions.
  function captureNativeListReadGuard({ document = globalThis.document, location = globalThis.location,
    profileHeader, username: owner, listType, actor, readSession, isActive,
    deadline = Infinity, now = Date.now } = {}) {
    if (typeof readSession !== 'function' || typeof isActive !== 'function' || !username(actor)) return null;
    const initialPath = location.pathname;
    const originalBodyRoots = new Set(document.body?.children || []);
    const context = { profileHeader, username: owner, listType, dialog: null };
    let captured, originalNavigation;
    try {
      if (isActive() !== true || now() >= deadline) return null;
      const evidence = {}, value = inspectCurrent({ document, location, session: readSession() }, false, evidence);
      captured = nativeListBackdrop({ document, location, context }, { capture: true });
      if (!captured || value.accountVerified !== true || value.accountId !== actor
        || ['profile', 'rail', 'picture'].some(key => !captured.shown(evidence[key]))) return null;
      originalNavigation = evidence;
    } catch { return null; }
    const originalAncestors = new Set();
    for (let node = profileHeader; node; node = node.parentElement) originalAncestors.add(node);
    let retainedDialog = null, retainedBackdrop = null, invalid = false;
    let openingPortal = null, handoffEligible = false, handoffUsed = false, handoffGap = false, initialRoleSeen = false;
    const portalOf = node => {
      let root = node;
      while (root?.parentElement && root.parentElement !== document.body) root = root.parentElement;
      return root && root !== node && root.parentElement === document.body && !originalBodyRoots.has(root)
        && !root.contains(profileHeader) && !root.contains(originalNavigation.rail) ? root : null;
    };
    const refuse = () => { invalid = true; return Object.freeze({ phase: 'invalid', dialog: null }); };
    return Object.freeze({ check() {
      if (invalid) return refuse();
      try {
        if (isActive() !== true || location.origin !== origin || location.pathname !== initialPath) return refuse();
        // An empty dialog still has geometry. Do not infer its absence from text.
        const rendered = node => {
          if (!node?.isConnected || !node.getClientRects?.().length) return false;
          for (let parent = node; parent; parent = parent.parentElement) {
            const style = getComputedStyle(parent);
            if (parent.hidden || parent.getAttribute?.('aria-hidden') === 'true' || style.display === 'none'
              || ['hidden', 'collapse'].includes(style.visibility)
              || (style.opacity !== undefined && style.opacity !== '' && Number(style.opacity) === 0
                && parent !== node)) return false;
          }
          return true;
        };
        const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(rendered);
        if (dialogs.length > 1) return refuse();
        let gap = false;
        if (retainedDialog && (dialogs[0] !== retainedDialog || handoffGap)) {
          // One empty native skeleton may retire before its typed successor is
          // mounted. Keep only this newly inserted portal, never another popup.
          if (!handoffEligible || handoffUsed || !openingPortal?.isConnected
            || openingPortal.parentElement !== document.body) return refuse();
          if (dialogs.length) {
            if (portalOf(dialogs[0]) !== openingPortal || handoffGap && dialogs[0] === retainedDialog) return refuse();
            retainedDialog = dialogs[0]; handoffUsed = true; handoffEligible = false; handoffGap = false;
          } else { gap = true; handoffGap = true; }
        }
        if (dialogs.length) retainedDialog ||= dialogs[0];
        context.dialog = gap ? null : retainedDialog;
        const profile = nativeListBackdrop({ document, location, context },
          retainedDialog ? { opening: true, openingPortal: gap ? openingPortal : null } : { capture: true });
        if (!profile || profile.backdrop && (!originalAncestors.has(profile.backdrop)
          || retainedBackdrop && profile.backdrop !== retainedBackdrop)
          || profile.controls.some((control, index) => control !== captured.controls[index]
          || profile.totals[index] !== captured.totals[index])) return refuse();
        retainedBackdrop ||= profile.backdrop;
        if (retainedDialog && !initialRoleSeen) {
          initialRoleSeen = true;
          openingPortal = profile.empty ? portalOf(retainedDialog) : null;
          handoffEligible = Boolean(openingPortal);
        }
        if (profile.typed) handoffEligible = false;
        const evidence = {}, value = inspectCurrent({ document, location, session: readSession(),
          ...(retainedDialog ? { nativeListDialog: context } : {}) }, true, evidence, gap ? openingPortal : null);
        if (value.accountVerified !== true || value.accountId !== actor
          || ['profile', 'rail', 'picture'].some(key => evidence[key] !== originalNavigation[key]
            || !profile.shown(evidence[key]))) return refuse();
        if (profile.ready && inspectCurrent({ document, location, session: readSession(), nativeListDialog: context }).accountId !== actor) return refuse();
        return Object.freeze({ phase: now() >= deadline ? 'timeout' : profile.ready ? 'ready' : 'opening', dialog: context.dialog });
      } catch { return refuse(); }
    } });
  }
  Object.defineProperty(globalThis, 'InstaToolboxInstagramViewer', {
    configurable: false, writable: false, value: Object.freeze({ inspect, accountKey, captureNativeListReadGuard }),
  });
})();
