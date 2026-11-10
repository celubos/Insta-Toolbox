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
  function nativeListBackdrop({ document, location, context }) {
    const owner = username(context?.username), type = context?.listType;
    const header = context?.profileHeader, dialog = context?.dialog;
    if (!owner || !['followers', 'following'].includes(type)
      || !new RegExp(`^/${owner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/?$`, 'i').test(location.pathname)) return null;
    const backdrop = header?.closest?.('[aria-hidden="true"]');
    const rendered = (node, allowed = null) => {
      if (!node?.isConnected || !node.getClientRects?.().length || typeof getComputedStyle !== 'function') return false;
      for (let parent = node; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (parent.hidden || (parent.getAttribute?.('aria-hidden') === 'true' && parent !== allowed)
          || style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility)
          || (style.opacity !== undefined && style.opacity !== '' && Number(style.opacity) === 0)) return false;
      }
      return true;
    };
    if (!backdrop || backdrop === header || backdrop.contains(dialog) || !rendered(header, backdrop) || !rendered(dialog)) return null;
    const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(node => rendered(node));
    if (dialogs.length !== 1 || dialogs[0] !== dialog) return null;
    const labels = [dialog.getAttribute('aria-label'),
      ...[...dialog.querySelectorAll('[role="heading"], h1, h2')].filter(node => rendered(node)).map(node => node.textContent),
      String(dialog.textContent || '').split(/\r?\n/).map(line => line.trim()).find(Boolean)];
    const types = new Set(labels.map(label => String(label || '').normalize('NFKC').trim().toLowerCase().match(/^(followers|following)(?:\s|$)/)?.[1]).filter(Boolean));
    if (types.size !== 1 || !types.has(type)) return null;
    const headers = [...document.querySelectorAll('main header')].filter(node => rendered(node, backdrop));
    if (headers.length !== 1 || headers[0] !== header
      || ![...header.querySelectorAll('a[href], h1, h2, [role="heading"]')]
        .some(node => rendered(node, backdrop) && username(node.textContent) === owner)) return null;
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
    }
    return { backdrop, shown: node => rendered(node, backdrop)
      && node.closest?.('[aria-hidden="true"]') === backdrop };
  }
  function inspect({ document = globalThis.document, location = globalThis.location,
    session = globalThis.InstaToolboxInstagramInspector?.inspectSession?.() || {},
    reactionDialog = false, nativeListDialog = null } = {}) {
    const unavailable = { accountVerified: false, usable: false, accountId: null, threadId: null };
    if (location?.origin !== origin) return { ...unavailable, reason: 'instagram-origin-required' };
    const threadId = String(location.pathname).match(/^\/direct\/t\/([0-9]+)\/?$/)?.[1] || null;
    const restriction = session.sessionExpired || session.challenge || session.actionBlocked || session.rateLimited;
    if (restriction) return { ...unavailable, threadId, restriction: true, reason: 'instagram-restricted' };
    const nativeBackdrop = nativeListDialog === null ? null
      : nativeListBackdrop({ document, location, context: nativeListDialog });
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
    const profiles = [...document.querySelectorAll('a[role="link"][href]')].filter((link) => {
      if (!shown(link) || list?.contains(link)
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
          && (paths.has('/direct/inbox/') || paths.has('/direct/inbox') || messages)) return true;
      }
      return false;
    });
    // Instagram sometimes nests a profile link around another identical link.
    // That is one control, not two independent account identities.
    const profileControls = profiles.filter(link => !profiles.some(other =>
      other !== link && other.contains(link) && pathOf(other) === pathOf(link)));
    if (profileControls.length !== 1) return { ...unavailable, threadId, reason: 'account-navigation-unavailable' };
    const accountId = pickerAccount || username(pathOf(profileControls[0]).split('/')[1]);
    return { accountVerified: true, accountId, threadId, usable: Boolean(threadId),
      accountKey: accountKey(accountId), identityKind: 'verified-viewer-username',
      restriction: false, evidence: list ? 'visible-account-picker-and-navigation' : 'visible-account-navigation' };
  }
  Object.defineProperty(globalThis, 'InstaToolboxInstagramViewer', {
    configurable: false, writable: false, value: Object.freeze({ inspect, accountKey }),
  });
})();
