import { createNativeInboxDiscovery, nativeInboxSection } from './inbox-native-navigation.js';
import { createInboxReview } from './inbox-coordinator.js';

const ORIGIN = 'https://www.instagram.com';
const visible = (node) => Boolean(node?.isConnected && !node.closest?.('[hidden], [aria-hidden="true"]')
  && node.getClientRects?.().length);
const copy = (value) => structuredClone(value);
const CHECKPOINT_KIND = 'insta-toolbox-inbox-discovery';
const DISCOVERY_TTL_MS = 20 * 60_000;
const SECTIONS = ['primary', 'general', 'requests'];
const invalidCheckpoint = () => { throw new Error('inbox-discovery-checkpoint-invalid'); };

// Only bounded observations cross documents. Unknown fields never become
// selection, approval, native row evidence, or a verified message pane.
function readOnlyCheckpoint(value, at) {
  if (!value || value.version !== 1 || value.kind !== CHECKPOINT_KIND
    || typeof value.accountId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.accountId)
    || ![value.startedAt, value.savedAt, value.expiresAt].every(time => Number.isSafeInteger(time) && time >= 0)
    || value.startedAt > value.savedAt || value.savedAt > at || value.savedAt >= value.expiresAt
    || value.expiresAt - value.startedAt > DISCOVERY_TTL_MS) invalidCheckpoint();
  if (value.expiresAt <= at) throw new Error('inbox-discovery-recovery-expired');
  if (!Array.isArray(value.sections) || !value.sections.length || value.sections.length > SECTIONS.length) invalidCheckpoint();
  const sections = value.sections.map(entry => {
    if (!entry || !SECTIONS.includes(entry.section) || !Number.isSafeInteger(entry.samples)
      || entry.samples < 0 || entry.samples > 1_000) invalidCheckpoint();
    return { section: entry.section, samples: entry.samples };
  });
  const sectionNames = new Set(sections.map(entry => entry.section));
  if (sectionNames.size !== sections.length || !Array.isArray(value.conversations)
    || !value.conversations.length || value.conversations.length > 1_000) invalidCheckpoint();
  const ids = new Set();
  const conversations = value.conversations.map(entry => {
    if (!entry || typeof entry.threadId !== 'string' || !/^[0-9]{1,128}$/.test(entry.threadId)
      || ids.has(entry.threadId) || !Array.isArray(entry.sections) || !entry.sections.length
      || entry.sections.length > SECTIONS.length || new Set(entry.sections).size !== entry.sections.length
      || !entry.sections.every(section => sectionNames.has(section)
        && sections.some(item => item.section === section && item.samples > 0))) invalidCheckpoint();
    ids.add(entry.threadId);
    return { threadId: entry.threadId, sections: [...entry.sections] };
  });
  if (!Array.isArray(value.labels) || value.labels.length > conversations.length) invalidCheckpoint();
  const labeled = new Set();
  const labels = value.labels.map(entry => {
    if (!entry || !ids.has(entry.threadId) || labeled.has(entry.threadId)
      || typeof entry.title !== 'string' || entry.title.length > 160
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(entry.title)
      || (entry.username !== null && (typeof entry.username !== 'string'
        || !/^[A-Za-z0-9._]{1,30}$/.test(entry.username)))) invalidCheckpoint();
    const title = entry.title.replace(/\s+/g, ' ').trim();
    if (!title) invalidCheckpoint();
    labeled.add(entry.threadId);
    return { threadId: entry.threadId, title, username: entry.username?.toLowerCase() || null };
  });
  return { version: 1, kind: CHECKPOINT_KIND, accountId: value.accountId,
    startedAt: value.startedAt, expiresAt: value.expiresAt, savedAt: value.savedAt,
    sections, conversations, labels };
}

// Inventory, review, and captured native navigation never approve cleanup.
export function createUserscriptInboxDiscovery({
  document = globalThis.document, window = globalThis.window,
  viewer = globalThis.InstaToolboxInstagramViewer, now = Date.now, onProgress = null,
  routeTimeoutMs = 8_000, settleMs = 400, checkpointStorage = null,
} = {}) {
  if (!document || !window?.location || typeof viewer?.inspect !== 'function'
    || typeof viewer.accountKey !== 'function' || typeof now !== 'function'
    || (onProgress !== null && typeof onProgress !== 'function')
    || (checkpointStorage !== null && (typeof checkpointStorage?.read !== 'function'
      || typeof checkpointStorage?.write !== 'function'))) throw new Error('inbox-discovery-unavailable');
  let active = null, inventory = null, captured = null, navigator = null, opening = null;
  let restoring = null, recovery = null, operationEpoch = 0;
  let state = { status: 'idle', reason: null, inventory: null, executionAvailable: false,
    recovered: false, recoveryExpiresAt: null };
  const snapshot = () => copy(state);
  const inboxReady = () => /^\/direct\/(?:inbox\/?|t\/\d+\/?)$/.test(window.location.pathname)
    && [...document.querySelectorAll('[aria-label="Thread list"]')].filter(visible).length === 1;
  const publish = (patch) => {
    state = { ...state, ...patch };
    try { onProgress?.(snapshot()); } catch {}
    return snapshot();
  };
  function rejectContext(reason) {
    navigator?.stop(); navigator = null; captured = null; inventory = null; recovery = null;
    publish({ status: 'needs-attention', reason, inventory: null, recovered: false, recoveryExpiresAt: null });
    throw new Error(reason);
  }
  function context() {
    const evidence = viewer.inspect({ document, location: window.location });
    const key = viewer.accountKey(evidence?.accountId);
    if (evidence?.then || evidence?.accountVerified !== true || !key
      || evidence.accountKey !== key || evidence.identityKind !== 'verified-viewer-username'
      || window.location.origin !== ORIGIN) return rejectContext('inbox-viewer-unverified');
    if (evidence.restriction) return rejectContext('inbox-account-restricted');
    return { accountId: key, verified: true, restriction: null };
  }
  async function writeCheckpoint(value) {
    try { await checkpointStorage.write(value); }
    catch { throw new Error('inbox-discovery-checkpoint-unavailable'); }
  }
  function validateInventory() {
    if (active || opening || restoring) throw new Error('inbox-discovery-active');
    if (!inventory) throw new Error('inbox-discovery-required');
    const current = context();
    if (current.accountId !== inventory.accountId) return rejectContext('inbox-account-changed');
    if (recovery && now() >= recovery.expiresAt) throw new Error('inbox-discovery-recovery-expired');
    return current;
  }
  function section() {
    const roots = [...document.querySelectorAll('[aria-label="Thread list"]')].filter(visible);
    if (roots.length !== 1) return null;
    const selected = [...roots[0].querySelectorAll('[role="tab"][aria-selected="true"]')].filter(visible);
    if (!selected.length && !roots[0].querySelectorAll('[role="tab"]').length) return 'primary';
    if (selected.length !== 1) return null;
    const label = (selected[0].getAttribute('aria-label') || selected[0].textContent || '').trim();
    return nativeInboxSection(label);
  }
  const stop = () => {
    operationEpoch += 1;
    if (restoring) { restoring.abort(); restoring = null; return true; }
    if (opening) { opening.abort(); return true; }
    if (navigator) { navigator.stop(); navigator = null; return true; }
    if (!active) return false;
    active.stop(); publish({ status: 'stopping', reason: 'cancelled', inventory: active.snapshot() });
    return true;
  };
  return Object.freeze({
    snapshot, stop,
    async hasReadOnlyCheckpoint() {
      if (!checkpointStorage) return false;
      try { readOnlyCheckpoint(await checkpointStorage.read(), now()); return true; }
      catch { return false; }
    },
    async restoreReadOnly() {
      if (active || opening || restoring) throw new Error('inbox-discovery-active');
      if (!checkpointStorage) throw new Error('inbox-discovery-checkpoint-unavailable');
      const identity = context(), epoch = ++operationEpoch;
      const controller = new AbortController(); restoring = controller;
      navigator?.stop(); navigator = null; captured = null; inventory = null; recovery = null;
      const interrupted = () => stop();
      window.addEventListener?.('pagehide', interrupted);
      document.addEventListener?.('freeze', interrupted);
      try {
        let value;
        try { value = await checkpointStorage.read(); }
        catch { throw new Error('inbox-discovery-checkpoint-unavailable'); }
        if (controller.signal.aborted || epoch !== operationEpoch) throw new Error('cancelled');
        const current = context();
        if (current.accountId !== identity.accountId) return rejectContext('inbox-account-changed');
        const saved = readOnlyCheckpoint(value, now());
        if (saved.accountId !== current.accountId) return rejectContext('inbox-account-changed');
        recovery = saved;
        inventory = { version: 1, accountId: current.accountId, complete: false, stopped: true,
          reason: 'recovered-observation', visits: 0, needsInboxReturn: !inboxReady(),
          sections: saved.sections.map(entry => ({ ...entry, complete: false, reason: 'recovered-observation' })),
          conversations: copy(saved.conversations) };
        return publish({ status: 'ready', reason: 'recovered-observation', inventory,
          recovered: true, recoveryExpiresAt: saved.expiresAt, executionAvailable: false });
      } catch (error) {
        if (epoch === operationEpoch) publish({ status: 'needs-attention', reason: error.message,
          inventory: null, recovered: false, recoveryExpiresAt: null });
        throw error;
      } finally {
        if (restoring === controller) restoring = null;
        window.removeEventListener?.('pagehide', interrupted);
        document.removeEventListener?.('freeze', interrupted);
      }
    },
    availableSections() {
      const roots = [...document.querySelectorAll('[aria-label="Thread list"]')].filter(visible);
      if (roots.length !== 1) return [];
      const sections = [...new Set([...roots[0].querySelectorAll('[role="tab"]')]
        .filter(visible)
        .map((tab) => nativeInboxSection(tab.getAttribute('aria-label') || tab.textContent))
        .filter(Boolean))];
      return sections.length ? sections : ['primary'];
    },
    reviewLabels() {
      const current = context();
      if (state.inventory && current.accountId !== state.inventory.accountId) return rejectContext('inbox-account-changed');
      if (recovery) {
        if (now() >= recovery.expiresAt) throw new Error('inbox-discovery-recovery-expired');
        return recovery.labels.map(label => ({ ...label, kind: label.username ? 'profile' : 'chat-title', source: 'recovered-observation' }));
      }
      return (active || captured)?.reviewLabels() || [];
    },
    async discover({ navigationAcknowledged = false, sections = null, expiresAt = now() + 20 * 60_000,
      targetThreadId = null, signal = null } = {}) {
      if (active || opening) throw new Error('inbox-discovery-active');
      if (navigationAcknowledged !== true) throw new Error('navigation-acknowledgment-required');
      if (!Number.isFinite(expiresAt) || expiresAt <= now() || expiresAt > now() + 20 * 60_000) throw new Error('discovery-expired');
      const identity = context(), startedAt = now(), epoch = ++operationEpoch;
      restoring?.abort(); restoring = null;
      navigator?.stop(); navigator = null; captured = null; inventory = null; recovery = null;
      publish({ status: 'discovering', reason: null, inventory: null, recovered: false, recoveryExpiresAt: null });
      if (checkpointStorage) {
        const controller = new AbortController(); opening = controller;
        try {
          await writeCheckpoint(null);
          if (controller.signal.aborted || signal?.aborted || epoch !== operationEpoch) throw new Error('cancelled');
          if (context().accountId !== identity.accountId) return rejectContext('inbox-account-changed');
          if (now() >= expiresAt) throw new Error('discovery-expired');
        } catch (error) {
          publish({ status: 'needs-attention', reason: error.message, inventory: null });
          throw error;
        } finally { if (opening === controller) opening = null; }
      }
      if (!inboxReady()) {
        const links = [...document.querySelectorAll('a[href]')].filter(node => {
          if (!visible(node)) return false;
          try { const target = new URL(node.getAttribute('href'), ORIGIN);
            if (target.origin !== ORIGIN) return false;
            if (/^\/direct\/inbox\/?$/.test(target.pathname)) return true;
            return /^\/direct\/t\/\d+\/?$/.test(target.pathname)
              && (node.getAttribute('aria-label') === 'Messages'
                || node.querySelector('[aria-label="Messages"]')); }
          catch { return false; }
        });
        if (!links.length) throw new Error('inbox-return-unavailable');
        opening = new AbortController();
        publish({ status: 'discovering', reason: null, inventory: null });
        const deadline = now() + routeTimeoutMs;
        try {
          links[0].click();
          while (true) {
            if (opening.signal.aborted) throw new Error('cancelled');
            const observed = viewer.inspect({ document, location: window.location });
            if (observed?.restriction) throw new Error('inbox-account-restricted');
            if (observed?.accountVerified && observed.accountKey !== identity.accountId) throw new Error('inbox-account-changed');
            if (inboxReady() && observed?.accountVerified && observed.accountKey === identity.accountId) break;
            if (now() >= deadline) throw new Error('navigation-timeout');
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          if (opening.signal.aborted) throw new Error('cancelled');
        } catch (error) {
          publish({ status: 'needs-attention', reason: error.message, inventory: null });
          throw error;
        } finally { opening = null; }
      }
      if (sections === null) sections = this.availableSections();
      const operation = createNativeInboxDiscovery({
        accountId: identity.accountId, resolveAccount: context,
        navigationAcknowledged, document, window, sections, expiresAt, now,
        routeTimeoutMs, settleMs, resolveSection: section,
        targetThreadId, signal,
        onProgress: (value) => publish({ inventory: value }),
        onCheckpoint: checkpointStorage ? async (value, labels) => {
          if (epoch !== operationEpoch || signal?.aborted) throw new Error('cancelled');
          const saved = readOnlyCheckpoint({ version: 1, kind: CHECKPOINT_KIND, accountId: identity.accountId,
            startedAt, expiresAt, savedAt: now(), sections: value.sections,
            conversations: value.conversations, labels }, now());
          await writeCheckpoint(saved);
        } : null,
      });
      active = operation;
      const interrupted = () => { operation.stop(); publish({ status: 'stopping', reason: 'page-interrupted' }); };
      document.addEventListener?.('freeze', interrupted);
      window.addEventListener?.('pagehide', interrupted);
      publish({ status: 'discovering', reason: null, inventory: operation.snapshot() });
      try {
        const result = await operation.run();
        const current = context();
        if (current.accountId !== identity.accountId) throw new Error('inbox-account-changed');
        inventory = copy(result);
        captured = operation;
        return publish({ status: result.stopped ? 'needs-attention' : 'ready',
          reason: result.reason, inventory: result });
      } catch (error) {
        captured = null; inventory = null;
        publish({ status: 'needs-attention', reason: error.message, inventory: null });
        throw error;
      } finally {
        document.removeEventListener?.('freeze', interrupted);
        window.removeEventListener?.('pagehide', interrupted);
        if (active === operation) active = null;
      }
    },
    createNavigator({ expiresAt } = {}) {
      if (active) throw new Error('inbox-discovery-active');
      if (!inventory || !captured) throw new Error('inbox-discovery-required');
      const current = context();
      if (current.accountId !== inventory.accountId) {
        navigator?.stop(); navigator = null; captured = null; inventory = null;
        publish({ status: 'needs-attention', reason: 'inbox-account-changed', inventory: null });
        throw new Error('inbox-account-changed');
      }
      const native = captured.createNavigator({ expiresAt });
      navigator?.stop();
      navigator = Object.freeze({
        stop: () => native.stop(),
        async navigate(threadId, options) {
          try { return await native.navigate(threadId, options); }
          catch (error) {
            if (/account-changed|viewer-unverified|origin-changed/.test(error.message)) {
              captured = null; inventory = null;
            }
            publish({ status: 'needs-attention', reason: error.message, inventory });
            throw error;
          }
        },
      });
      return navigator;
    },
    review({ threadIds, scope = 'all', limit = null } = {}) {
      const current = validateInventory();
      const available = new Set(inventory.conversations.map((entry) => entry.threadId));
      if (!Array.isArray(threadIds) || !threadIds.length
        || !threadIds.every((id) => available.has(id))) throw new Error('thread-not-discovered');
      return createInboxReview({ accountId: current.accountId, threadIds, scope, limit,
        speed: 'standard', workerCount: 1, removeOwnReactions: false,
        ...(recovery ? { expiresAt: recovery.expiresAt } : {}),
        discovery: { sections: inventory.sections.filter((entry) => entry.samples > 0).map((entry) => entry.section),
          complete: inventory.complete === true },
      }, now());
    },
    validateReview(review) {
      const current = validateInventory();
      if (!review || review.accountId !== current.accountId) throw new Error('inbox-review-changed');
      if (!Number.isFinite(review.expiresAt) || now() >= review.expiresAt) throw new Error('inbox-review-expired');
      const available = new Set(inventory.conversations.map(entry => entry.threadId));
      if (!Array.isArray(review.threadIds) || !review.threadIds.length || review.threadIds.length > 1_000
        || !review.threadIds.every(id => available.has(id))) throw new Error('thread-not-discovered');
      return true;
    },
  });
}
