import assert from 'node:assert/strict';
import test from 'node:test';
import { mountPresenceGrowthPanel } from '../extension/presence-growth-panel.js';

class Element {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.listeners = {};
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return (this.text || '') + this.children.map((child) => child.textContent).join(''); }
  setAttribute() {}
  append(...children) { this.children.push(...children); }
  prepend(...children) { this.children.unshift(...children); }
  replaceChildren(...children) { this.children = [...children]; this.text = ''; }
  querySelectorAll(selector) {
    const all = this.children.flatMap((node) => [node, ...node.querySelectorAll?.('*') || []]);
    if (selector === '*') return all;
    if (selector === 'input:checked') return all.filter((node) => node.tagName === 'input' && node.checked);
    return [];
  }
  addEventListener(type, handler) { this.listeners[type] = handler; }
  remove() {}
}

function fixture() {
  let clock = 100 * 86_400_000;
  let campaigns = [];
  let viewer = { accountVerified: true, usable: true, accountId: 'owner' };
  let approval = true;
  const runs = [];
  const reviews = [];
  const scans = [];
  const document = { createElement: (tag) => new Element(tag), createTextNode: (text) => {
    const node = new Element('#text'); node.textContent = text; return node;
  } };
  const container = document.createElement('div');
  const panel = mountPresenceGrowthPanel({ container, document,
    inspectAccount: () => viewer,
    readFollowing: () => ['seed', 'already'],
    readFollowers: () => [],
    readFollowingSnapshot: () => ({ subjectUsername: 'owner', listType: 'following', verified: true,
      source: 'authenticated-web', capturedAt: new Date(100 * 86_400_000).toISOString(), complete: true,
      accounts: ['seed', 'already'].map(username => ({ username, source: 'authenticated-instagram-web' })) }),
    scanSeed: async (username) => { scans.push(username); return {
      username, source: 'authenticated-instagram-web', userId: '100', subjectInstagramId: '100',
      capturedAt: new Date(clock).toISOString(),
      followers: ['candidate', 'already'].map(username => ({ username, source: 'authenticated-instagram-web' })),
      following: ['candidate', 'already', 'one_way'].map(username => ({ username, source: 'authenticated-instagram-web' })),
      complete: { followers: true, following: true }, expectedCounts: { followers: 2, following: 3 },
      pages: { followers: 1, following: 1 }, reasons: { followers: 'pagination-complete', following: 'pagination-complete' },
    }; },
    readCampaigns: () => campaigns,
    writeCampaigns: (value) => { campaigns = value; },
    confirmAction: async ({ binding }) => {
      reviews.push(binding);
      return approval ? binding : null;
    },
    runBatch: async (run) => { runs.push(run); },
    now: () => clock,
  });
  const all = () => container.querySelectorAll('*');
  const input = all().find((node) => node.tagName === 'input' && node.type === 'text');
  const select = all().find((node) => node.tagName === 'select');
  return { panel, runs, reviews, scans, campaigns: () => campaigns, input, select,
    root: container.children[0],
    summary: all().find((node) => node.tagName === 'summary'),
    setClock: (value) => { clock = value; },
    setViewer: (value) => { viewer = value; },
    setApproval: (value) => { approval = value; },
  };
}

test('growth panel scans selected following and submits only reviewed positive candidates', async () => {
  const app = fixture();
  app.input.value = '@seed';
  await app.panel.findCandidates();
  assert.deepEqual(app.scans, ['seed']);
  app.select.value = '9';
  await app.panel.reviewFollow();
  assert.equal(app.runs.length, 1);
  assert.deepEqual(app.runs[0].usernames, ['candidate']);
  assert.equal(app.runs[0].action, 'follow');
  assert.equal(app.runs[0].expiresAt, app.reviews[0].expiresAt);
  assert.equal(app.runs[0].expiresAt, 100 * 86_400_000 + 15 * 60_000);
  assert.equal(app.campaigns()[0].delayDays, 9);
});

test('cancel never creates a campaign or dispatches a Follow', async () => {
  const app = fixture();
  app.input.value = 'seed';
  await app.panel.findCandidates();
  app.setApproval(false);
  await app.panel.reviewFollow();
  assert.equal(app.runs.length, 0);
  assert.deepEqual(app.campaigns(), []);
});

test('a seed outside captured Following never starts a network scan', async () => {
  const app = fixture();
  app.input.value = 'stranger';
  await app.panel.findCandidates();
  assert.deepEqual(app.scans, []);
  assert.equal(app.runs.length, 0);
});

test('unfollow review requires a verified Follow and the due date on the same account', async () => {
  const app = fixture();
  app.input.value = 'seed';
  await app.panel.findCandidates();
  await app.panel.reviewFollow();
  const campaign = app.campaigns()[0];
  await app.panel.reviewDue();
  assert.equal(app.runs.length, 1);
  app.campaigns()[0] = { ...campaign, followed: { candidate: 100 * 86_400_000 } };
  app.setClock(109 * 86_400_000);
  app.setViewer({ accountVerified: true, usable: true, accountId: 'other' });
  await app.panel.reviewDue();
  assert.equal(app.runs.length, 1);
  app.setViewer({ accountVerified: true, usable: true, accountId: 'owner' });
  await app.panel.reviewDue();
  assert.equal(app.runs.length, 2);
  assert.equal(app.runs[1].action, 'unfollow');
  assert.deepEqual(app.runs[1].usernames, ['candidate']);
  assert.equal(app.runs[1].expiresAt, app.reviews.at(-1).expiresAt);
});

test('collapsed growth keeps account-bound due reviews discoverable without dispatching work', async () => {
  const app = fixture();
  assert.equal(app.root.open, false, 'the session remains the first task on Presence');
  assert.equal(app.summary.textContent, 'Grow through mutuals');
  app.input.value = 'seed';
  await app.panel.findCandidates();
  await app.panel.reviewFollow();
  const campaign = app.campaigns()[0];
  app.campaigns()[0] = { ...campaign, followed: { candidate: 100 * 86_400_000 } };
  app.setClock(106 * 86_400_000);
  app.panel.render();
  assert.equal(app.summary.textContent, 'Grow through mutuals', 'not due before the chosen wait');
  app.setClock(107 * 86_400_000);
  app.panel.render();
  assert.match(app.summary.textContent, /review unfollows/);
  assert.equal(app.root.open, false, 'a due review does not force the session out of view');
  assert.equal(app.runs.length, 1, 'a visible due reminder never authorizes an Unfollow');
  app.setViewer({ accountVerified: true, usable: true, accountId: 'other' });
  app.panel.render();
  assert.equal(app.summary.textContent, 'Grow through mutuals', 'another account has no reminder');
  app.setViewer({ accountVerified: true, usable: true, accountId: 'owner' });
  app.panel.render();
  assert.match(app.summary.textContent, /review unfollows/);
  app.campaigns()[0].unfollowed.candidate = 107 * 86_400_000;
  app.panel.render();
  assert.equal(app.summary.textContent, 'Grow through mutuals', 'finished reviews leave no stale reminder');
});
