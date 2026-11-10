import {
  createGrowthCampaign, dueGrowthUnfollows, growthUsername, rankGrowthCandidates,
} from './presence-growth.js';
import {
  createGrowthReadDraft, growthDraftSeedDone, growthDraftSeedSources, growthFollowingSnapshot,
  recordGrowthSeedRead, resumeGrowthReadDraft, stopGrowthReadDraft, validateGrowthReadDraft,
} from './presence-growth-draft.js';

const label = (name) => `@${name}`;
const searchFailure = error => /^growth-/.test(String(error?.message || ''))
  ? 'This profile read could not be verified. Keep the selected profile open and read it again.'
  : String(error?.message || 'This profile could not be read. Earlier reads are kept.');

export function mountPresenceGrowthPanel({
  container, inspectAccount, readFollowing, readFollowers, scanSeed,
  readCampaigns, writeCampaigns, confirmAction, runBatch,
  readFollowingSnapshot = () => null, readReadDraft = () => null, writeReadDraft = null,
  readCurrentProfile = () => '', readSeedNative = null, inspectReadAccount = null,
  canRunBatch = () => true,
  busy = () => false, onStatus = () => {}, document = globalThis.document,
  window = globalThis.window, now = Date.now,
} = {}) {
  if (!container || !document?.createElement || ![inspectAccount, readFollowing, readFollowers,
    scanSeed, readCampaigns, writeCampaigns, confirmAction, runBatch].every((fn) => typeof fn === 'function')) {
    throw new Error('presence-growth-adapter-required');
  }
  const make = (tag, text) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const root = make('details');
  root.className = 'presence-growth';
  root.open = false;
  const summary = make('summary', 'Grow through mutuals');
  const note = make('p', 'Choose up to three accounts from your Following list.');
  const seedLabel = make('label', 'Accounts you follow');
  const seedInput = make('input');
  seedInput.type = 'text';
  seedInput.placeholder = '@first, @second';
  seedInput.autocomplete = 'off';
  seedInput.setAttribute('aria-label', 'Accounts you follow, separated by commas');
  seedLabel.append(seedInput);
  const daysLabel = make('label', 'Review unfollows after');
  const days = make('select');
  for (let count = 7; count <= 14; count += 1) {
    const option = make('option', `${count} days`);
    option.value = String(count);
    days.append(option);
  }
  days.value = '7';
  daysLabel.append(days);
  const find = make('button', 'Find mutual connections');
  const cancel = make('button', 'Stop search');
  const follow = make('button', 'Review follows');
  const due = make('button', 'Review due unfollows');
  for (const button of [find, cancel, follow, due]) button.type = 'button';
  find.className = 'button primary';
  cancel.className = 'button quiet';
  follow.className = 'button primary';
  due.className = 'button quiet';
  const progress = make('p', 'Check your Following list in Mutual Checker first.');
  const candidatesList = make('div');
  candidatesList.className = 'presence-growth-candidates';
  const dueList = make('p');
  const readSteps = make('div');
  const readNote = make('p', 'Open each account below, then choose Read current seed. Your read progress is kept in this userscript.');
  const seedLinks = make('ul');
  const readCurrent = make('button', 'Read current seed'); readCurrent.type = 'button'; readCurrent.className = 'button primary';
  const restart = make('button', 'Start a new search'); restart.type = 'button'; restart.className = 'button quiet';
  readSteps.append(readNote, seedLinks, readCurrent, restart); readSteps.hidden = true;
  const style = make('style', `
    .presence-growth{border-top:1px solid var(--insta-toolbox-line);padding-top:8px;min-width:0}
    .presence-growth>summary{min-height:44px;display:flex;align-items:center;cursor:pointer;font-weight:700;-webkit-text-fill-color:currentColor}
    .presence-growth>summary::after{content:'▾';margin-left:auto;font-size:16px}
    .presence-growth:not([open])>summary::after{content:'▸'}
    .presence-growth>p{margin:4px 0 12px;line-height:1.45}
    .presence-growth label{display:grid;gap:6px;margin:0 0 12px}
    .presence-growth input:not([type=checkbox]),.presence-growth select{box-sizing:border-box;width:100%;min-height:44px;padding:8px 10px;border:1px solid var(--insta-toolbox-line);border-radius:8px;color:var(--insta-toolbox-text);background:var(--insta-toolbox-bg-sunken);font:inherit}
    .presence-growth button{margin:0 8px 8px 0;white-space:normal}
    .presence-growth ul{padding-left:20px;overflow-wrap:anywhere}
    .presence-growth li{padding:4px 0}
    .presence-growth a{display:inline-flex;align-items:center;min-height:44px;color:var(--insta-toolbox-accent,LinkText)}
    .presence-growth-candidates{display:grid;gap:4px;max-height:220px;overflow:auto;margin:8px 0}
    .presence-growth-candidates label{display:flex;align-items:center;min-height:44px;margin:0;padding:6px;border-bottom:1px solid var(--insta-toolbox-line);overflow-wrap:anywhere}
    .presence-growth-candidates input{margin-right:8px;flex:none}
    .presence-growth [hidden]{display:none!important}
    .presence-growth :focus-visible{outline:2px solid var(--insta-toolbox-accent,Highlight);outline-offset:2px}
    @media(forced-colors:active){.presence-growth input,.presence-growth select{border-color:CanvasText}.presence-growth>summary{color:LinkText;-webkit-text-fill-color:LinkText}}
  `);
  root.append(style, summary, note, seedLabel, daysLabel, find, cancel, progress,
    readSteps, candidatesList, follow, dueList, due);
  container.prepend(root);

  let controller = null;
  let candidates = [];
  let selectedSeeds = [];
  let incompleteSeeds = [];
  let readDraft = null;
  let persistedDraft = false;
  let disposed = false;
  let readGeneration = 0;
  let readingSeed = '';
  const selection = () => [...new Set(seedInput.value.split(/[\s,]+/).map(growthUsername).filter(Boolean))];
  const setProgress = (message) => { progress.textContent = message; onStatus(message); };
  const account = () => {
    let value = inspectAccount();
    if (value?.accountVerified !== true && controller && readingSeed && typeof inspectReadAccount === 'function') {
      value = inspectReadAccount({ actor: readDraft?.actor, seed: readingSeed });
    }
    return value?.accountVerified === true && value.usable === true
      ? growthUsername(value.accountId) : '';
  };
  const campaigns = () => {
    const saved = readCampaigns();
    return (Array.isArray(saved) ? saved : [])
    .filter((item) => item?.schemaVersion === 1 && item.account === account()
      && typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 100
      && Number.isInteger(item.delayDays) && item.delayDays >= 7 && item.delayDays <= 14
      && Array.isArray(item.targets) && item.targets.length > 0 && item.targets.length <= 50
      && item.targets.every((target) => growthUsername(target) === target)
      && item.followed && typeof item.followed === 'object'
      && item.unfollowed && typeof item.unfollowed === 'object').slice(-100);
  };

  const ordered = value => Array.isArray(value) ? value.map(ordered)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
  const same = (left, right) => JSON.stringify(ordered(left)) === JSON.stringify(ordered(right));
  const storedDraft = () => readReadDraft(readDraft?.actor || account(), readingSeed);
  const currentDraft = ({ stored = true, profile = '' } = {}) => {
    try {
      const valid = validateGrowthReadDraft(readDraft, {
        actor: account(), followingSnapshot: readFollowingSnapshot(), now: now(),
      });
      if (!valid || !same(selection(), valid.seeds)
        || (profile && readCurrentProfile() !== profile)
        || (stored && persistedDraft && !same(storedDraft(), readDraft))) return null;
      return valid;
    } catch { return null; }
  };
  function storeDraft(value, previous = persistedDraft ? readDraft : storedDraft()) {
    if (typeof writeReadDraft !== 'function') throw new Error('Your userscript manager could not keep this read. Start a new search after reloading.');
    if (!same(storedDraft(), previous)) throw new Error('This search changed in another tab. Reopen Grow through mutuals before reading again.');
    writeReadDraft(value, readDraft?.actor || account(), readingSeed);
    if (!same(storedDraft(), value)) throw new Error('The read progress could not be saved. No follow was started.');
    readDraft = value;
    persistedDraft = Boolean(value);
  }
  function clearCandidates() {
    candidates = []; selectedSeeds = []; incompleteSeeds = [];
    candidatesList.replaceChildren();
  }
  function applyDraftCandidates() {
    const valid = currentDraft();
    clearCandidates();
    if (!valid || valid.status !== 'active' || valid.seeds.some(seed => !growthDraftSeedDone(valid, seed))) {
      render(); return;
    }
    selectedSeeds = growthDraftSeedSources(valid);
    incompleteSeeds = valid.seeds.filter(seed => ['followers', 'following'].some(type => !valid.results[seed].lists[type].complete));
    candidates = rankGrowthCandidates({ account: valid.actor, seeds: selectedSeeds,
      following: valid.followingSnapshot.accounts, followers: valid.followers });
    renderCandidates();
    const partial = incompleteSeeds.length
      ? ` Partial lists: ${incompleteSeeds.map(label).join(', ')}; other connections may be missing.` : '';
    setProgress(candidates.length
      ? `${candidates.length} observed mutual connections. Select exact accounts to review.${partial}`
      : `No observed mutual connections to review.${partial}`);
  }
  function renderReadSteps(valid) {
    readSteps.hidden = !persistedDraft || !valid;
    seedLinks.replaceChildren();
    if (!persistedDraft || !valid) return;
    for (const seed of valid.seeds) {
      const row = make('li'), link = make('a', `Open ${label(seed)} profile`);
      link.href = `https://www.instagram.com/${seed}/`;
      row.append(link, document.createTextNode(growthDraftSeedDone(valid, seed)
        ? ' · read' : valid.results[seed] ? ' · partly read' : ' · waiting to read'));
      seedLinks.append(row);
    }
    const here = readCurrentProfile();
    const allRead = valid.seeds.every(seed => growthDraftSeedDone(valid, seed));
    readCurrent.textContent = allRead && valid.status === 'stopped' ? 'Show read results' : 'Read current seed';
    readCurrent.hidden = allRead && valid.status === 'active';
    readCurrent.disabled = Boolean(controller) || busy() || (!allRead && (!valid.seeds.includes(here) || growthDraftSeedDone(valid, here)));
    restart.disabled = Boolean(controller);
  }

  function render() {
    const owner = account();
    const savedCampaigns = campaigns();
    const nextDue = savedCampaigns.map((campaign) => ({ campaign,
      targets: dueGrowthUnfollows(campaign, { account: owner, now: now() }) }))
      .find(({ targets }) => targets.length);
    summary.textContent = nextDue
      ? 'Grow through mutuals · review unfollows'
      : 'Grow through mutuals';
    dueList.hidden = savedCampaigns.length === 0;
    due.hidden = !nextDue;
    daysLabel.hidden = candidates.length === 0;
    follow.hidden = candidates.length === 0;
    dueList.textContent = nextDue
      ? `${nextDue.targets.length} campaign follow${nextDue.targets.length === 1 ? '' : 's'} due for review.`
      : 'No campaign unfollows due yet. Reopen Instagram after your chosen wait to review them.';
    due.disabled = !nextDue || Boolean(controller) || busy() || !canRunBatch();
    const valid = readDraft ? currentDraft() : null;
    renderReadSteps(valid);
    if (readDraft && !valid) { clearCandidates(); controller?.abort(); }
    cancel.hidden = !controller && !(persistedDraft && valid?.status === 'active');
    seedInput.disabled = Boolean(controller);
    find.hidden = Boolean(persistedDraft && valid);
    find.disabled = Boolean(controller) || busy();
    follow.disabled = !candidates.length || Boolean(controller) || busy() || !canRunBatch() || !valid || valid.status !== 'active';
  }

  function renderCandidates() {
    candidatesList.replaceChildren();
    for (const [index, candidate] of candidates.entries()) {
      const row = make('label');
      const checkbox = make('input');
      checkbox.type = 'checkbox';
      checkbox.value = candidate.username;
      checkbox.checked = index < 10;
      row.append(checkbox, document.createTextNode(
        `${label(candidate.username)} · mutual with ${candidate.via.map(label).join(', ')}`));
      candidatesList.append(row);
    }
    render();
  }

  async function findCandidates() {
    if (controller || busy()) return;
    const owner = account();
    const following = readFollowing();
    const followingNames = new Set((Array.isArray(following) ? following : [])
      .map((entry) => growthUsername(entry?.username || entry)).filter(Boolean));
    const seeds = selection();
    if (!owner || !followingNames.size) {
      setProgress('Check your own Following list in Mutual Checker first.'); return;
    }
    if (!seeds.length || seeds.length > 3 || seeds.some((name) => !followingNames.has(name))) {
      setProgress('Enter one to three accounts found in your captured Following list.'); return;
    }
    const snapshot = growthFollowingSnapshot(readFollowingSnapshot(), { actor: owner, now: now() });
    if (!snapshot) { setProgress('Read your own Following list again in Mutual Checker, then start this search.'); return; }
    const fresh = createGrowthReadDraft({ actor: owner, followingSnapshot: snapshot, followers: readFollowers(), seeds,
      now: now(), id: globalThis.crypto?.randomUUID?.() || `read-${now()}-${Math.random().toString(16).slice(2)}` });
    if (persistedDraft) storeDraft(null);
    readDraft = fresh;
    persistedDraft = false;
    const storedAtStart = storedDraft();
    const active = new AbortController();
    controller = active;
    const generation = ++readGeneration;
    clearCandidates();
    renderCandidates();
    const assertCurrent = () => {
      if (disposed || active.signal.aborted || generation !== readGeneration || !currentDraft()) {
        active.abort(); throw new Error('Search stopped or its account, Following list, or selected seeds changed. Start a new search.');
      }
    };
    try {
      for (const [index, seed] of seeds.entries()) {
        assertCurrent();
        setProgress(`Checking ${label(seed)} (${index + 1} of ${seeds.length})…`);
        const startedAt = now();
        const result = await scanSeed(seed, active.signal, (update) => {
          assertCurrent();
          const part = update?.listType === 'followers' || update?.listType === 'following'
            ? `${update.listType}: ${Math.max(0, Number(update.found) || 0)} read`
            : 'resolving profile';
          setProgress(`Checking ${label(seed)} (${index + 1} of ${seeds.length}) · ${part}`);
        });
        assertCurrent();
        readDraft = recordGrowthSeedRead(readDraft, { seed, result, startedAt, now: now() });
      }
      applyDraftCandidates();
    } catch (error) {
      if (error?.lookupRoutesRetired === true && error.code === 'request-failed' && [404, 410].includes(error.httpStatus)
        && !active.signal.aborted && currentDraft()
        && typeof readSeedNative === 'function' && typeof writeReadDraft === 'function') {
        storeDraft(readDraft, storedAtStart);
        setProgress('Open each selected profile below, then choose Read current seed. Nothing will be followed until you review it.');
      } else {
        clearCandidates();
        setProgress(active.signal.aborted ? 'Search stopped.' : searchFailure(error));
      }
    } finally {
      if (controller === active) controller = null;
      render();
    }
  }

  async function readCurrentSeed() {
    if (controller || busy() || disposed || typeof readSeedNative !== 'function') return;
    const valid = currentDraft(), seed = readCurrentProfile();
    if (persistedDraft && valid?.status === 'stopped' && valid.seeds.every(name => growthDraftSeedDone(valid, name))) {
      storeDraft(resumeGrowthReadDraft(valid, { now: now() })); applyDraftCandidates(); return;
    }
    if (!persistedDraft || !valid || !valid.seeds.includes(seed) || growthDraftSeedDone(valid, seed)) {
      clearCandidates(); render();
      setProgress('Open a selected account using its profile link, then choose Read current seed.'); return;
    }
    const active = new AbortController(), generation = ++readGeneration, startedAt = now();
    if (valid.status === 'stopped') storeDraft(resumeGrowthReadDraft(valid, { now: now() }));
    controller = active;
    readingSeed = seed;
    clearCandidates(); render();
    const assertCurrent = () => {
      if (disposed || active.signal.aborted || generation !== readGeneration || !currentDraft({ profile: seed })) {
        active.abort(); throw new Error('Search stopped or its account, profile, Following list, or selected seeds changed.');
      }
    };
    const monitor = globalThis.setInterval(() => {
      try { assertCurrent(); } catch { active.abort(); }
    }, 100);
    try {
      assertCurrent();
      const result = await readSeedNative(seed, active.signal, update => {
        assertCurrent();
        setProgress(`Reading ${label(seed)}${update?.listType ? ` · ${update.listType}: ${Math.max(0, Number(update.found) || 0)} read` : '…'}`);
      });
      assertCurrent();
      storeDraft(recordGrowthSeedRead(readDraft, { seed, result, startedAt, now: now() }));
      if (readDraft.seeds.every(name => growthDraftSeedDone(readDraft, name))) applyDraftCandidates();
      else setProgress(`Read ${label(seed)}. Open the next selected profile and choose Read current seed.`);
    } catch (error) {
      // Interrupted observations stay read-only and never become follow targets.
      if (error?.partialResult && currentDraft({ stored: true })) {
        try {
          storeDraft(recordGrowthSeedRead(readDraft, { seed, result: error.partialResult, startedAt, now: now(), partial: true }));
        } catch { /* Keep the previously verified reads if this partial record is invalid. */ }
      }
      clearCandidates();
      setProgress(active.signal.aborted ? 'Search stopped. Earlier reads are kept; choose Read current seed to continue.'
        : searchFailure(error));
    } finally {
      globalThis.clearInterval(monitor);
      if (controller === active) controller = null;
      readingSeed = '';
      render();
    }
  }

  function stopSearch() {
    controller?.abort();
    readGeneration += 1;
    clearCandidates();
    const valid = currentDraft();
    if (persistedDraft && valid) {
      try { storeDraft(stopGrowthReadDraft(valid, { now: now() })); }
      catch (error) { setProgress(String(error?.message || 'Search stopped.')); }
    }
    setProgress('Search stopped. Earlier reads are kept; choose Read current seed to continue.');
    render();
  }

  function discardReadDraft() {
    controller?.abort(); readGeneration += 1;
    if (persistedDraft && same(storedDraft(), readDraft)) storeDraft(null);
    readDraft = null; persistedDraft = false; clearCandidates();
    setProgress('Choose one to three accounts from your Following list, then find mutual connections.');
    render();
  }

  async function reviewFollow() {
    const owner = account();
    const discovery = currentDraft();
    const targets = [...candidatesList.querySelectorAll('input:checked')].map((input) => input.value);
    if (!owner || controller || !discovery || discovery.status !== 'active'
      || discovery.seeds.some(seed => !growthDraftSeedDone(discovery, seed))
      || busy() || !canRunBatch() || !targets.length || targets.length > 25
      || targets.some(target => !candidates.some(candidate => candidate.username === target))) {
      setProgress('Select 1 to 25 candidates and stop other runs first.'); return;
    }
    const waitDays = Number(days.value);
    const expiresAt = now() + 15 * 60_000;
    const binding = { action: 'presence-growth-follow', account: owner,
      targets: JSON.stringify(targets), delayDays: waitDays, expiresAt };
    const approval = await confirmAction({ title: `Follow ${targets.length} accounts?`,
      message: 'Each profile is checked again before following.',
      detail: `After ${waitDays} days, these verified follows will appear here for unfollow review.`,
      confirmLabel: 'Start following', items: targets.map(label),
      facts: [{ label: 'Account', value: label(owner) }, { label: 'Targets', value: String(targets.length) }],
      binding });
    const currentTargets = [...candidatesList.querySelectorAll('input:checked')].map((input) => input.value);
    if (!approval || controller || account() !== owner || !same(currentDraft(), discovery) || busy() || !canRunBatch()
      || JSON.stringify(currentTargets) !== binding.targets || Number(days.value) !== waitDays
      || Object.keys(binding).some((key) => approval[key] !== binding[key])
      || expiresAt <= now()) return;
    const campaign = createGrowthCampaign({ account: owner, targets, delayDays: waitDays,
      createdAt: now(), id: globalThis.crypto?.randomUUID?.() || `growth-${now()}` });
    writeCampaigns([...campaigns(), campaign].slice(-100));
    setProgress(`Following ${targets.length} reviewed accounts. Use Stop in the run bar to end the batch.`);
    await runBatch({ action: 'follow', usernames: targets, growthCampaignId: campaign.id,
      growthAccount: owner, expiresAt });
    render();
  }

  async function reviewDue() {
    const owner = account();
    const entry = campaigns().map((campaign) => ({ campaign,
      targets: dueGrowthUnfollows(campaign, { account: owner, now: now() }) }))
      .find(({ targets }) => targets.length);
    if (!entry || controller || busy() || !canRunBatch()) return;
    const targets = entry.targets.slice(0, 25);
    const expiresAt = now() + 15 * 60_000;
    const binding = { action: 'presence-growth-unfollow', account: owner,
      campaignId: entry.campaign.id, targets: JSON.stringify(targets), expiresAt };
    const approval = await confirmAction({ title: `Unfollow ${targets.length} campaign accounts?`,
      message: 'Only verified follows from this campaign are listed. Each relationship is checked again.',
      confirmLabel: 'Start unfollowing', items: targets.map(label),
      facts: [{ label: 'Account', value: label(owner) }, { label: 'Targets', value: String(targets.length) }],
      binding });
    const fresh = campaigns().find((campaign) => campaign.id === entry.campaign.id);
    if (!approval || controller || account() !== owner || busy() || !canRunBatch() || !fresh
      || JSON.stringify(dueGrowthUnfollows(fresh, { account: owner, now: now() }).slice(0, 25)) !== binding.targets
      || Object.keys(binding).some((key) => approval[key] !== binding[key])
      || expiresAt <= now()) return;
    setProgress(`Unfollowing ${targets.length} reviewed campaign accounts.`);
    await runBatch({ action: 'unfollow', usernames: targets,
      growthCampaignId: entry.campaign.id, growthAccount: owner, expiresAt });
    render();
  }

  const launch = (operation) => {
    void operation().catch((error) => setProgress(searchFailure(error)));
  };
  find.addEventListener('click', () => launch(findCandidates));
  cancel.addEventListener('click', stopSearch);
  readCurrent.addEventListener('click', () => launch(readCurrentSeed));
  restart.addEventListener('click', () => launch(async () => discardReadDraft()));
  seedInput.addEventListener('input', () => { if (readDraft && !same(selection(), readDraft.seeds)) discardReadDraft(); });
  follow.addEventListener('click', () => launch(reviewFollow));
  due.addEventListener('click', () => launch(reviewDue));
  try {
    const saved = readReadDraft();
    const restored = validateGrowthReadDraft(saved, { actor: account(), followingSnapshot: readFollowingSnapshot(), now: now() });
    if (restored) {
      readDraft = restored; persistedDraft = true; seedInput.value = restored.seeds.join(', '); root.open = true;
      setProgress(restored.status === 'stopped' ? 'Search stopped. Choose Read current seed to continue.'
        : 'Open the next selected profile, then choose Read current seed.');
      applyDraftCandidates();
    }
  } catch { setProgress('Read your Following list in Mutual Checker before starting a new search.'); }
  const stopReadingOnPagehide = () => { if (controller) stopSearch(); };
  window?.addEventListener?.('pagehide', stopReadingOnPagehide);
  const contextStamp = () => `${readCurrentProfile()}|${account()}|${Boolean(readDraft && readDraft.expiresAt <= now())}`;
  let lastContext = contextStamp();
  const routeRefresh = globalThis.setInterval(() => {
    try {
      const context = contextStamp();
      if (!disposed && persistedDraft && context !== lastContext) { lastContext = context; render(); }
    } catch { controller?.abort(); }
  }, 250);
  routeRefresh.unref?.();
  render();
  return Object.freeze({ render, findCandidates, readCurrentSeed, stopSearch, discardReadDraft, reviewFollow, reviewDue,
    busy: () => Boolean(controller),
    dispose() { disposed = true; controller?.abort(); readGeneration += 1; globalThis.clearInterval(routeRefresh);
      window?.removeEventListener?.('pagehide', stopReadingOnPagehide); root.remove(); } });
}
