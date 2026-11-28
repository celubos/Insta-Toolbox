# Instagram interaction sandbox

This is a local, synthetic Instagram interaction model for testing the **actual
generated Insta Toolbox userscript**. It is not an Instagram service clone.
No Instagram JavaScript, account data, cookies, or messages are included.
It makes no requests to Instagram or other external services.

The fixture owns the relationships, posts, messages, and action ledger.
The production userscript must discover the rendered UI, request its normal
review, and click native-looking controls. Assertions compare its results with
that separate fixture state. They do not derive expected results from product
output.

## Run

Use the project's Node.js and pnpm environment and install dependencies first.
The browser harness uses the project's Electron dependency.

```sh
node scripts/build-userscript.mjs
node scripts/run-instagram-sandbox.mjs
```

To inspect and use the synthetic interface yourself:

```sh
node scripts/run-instagram-sandbox.mjs --interactive
```

The interactive window has synthetic Home, Explore, profile, followers,
following, story and inbox routes. The real toolbox runs over those pages.
Close the window to finish. Neither mode opens a personal browser profile.

For a focused non-worker run, set `INSTA_TOOLBOX_SANDBOX_SKIP_GHOST=1`.
That result excludes the Ghost worker gate and must not be reported as complete
worker validation.

## Coverage

| Workflow | Independent fixture behavior and assertion |
| --- | --- |
| Startup | The real bundle mounts once even when loaded twice. Rendering performs no native mutation. DM Unsend is unavailable off a conversation. |
| Mutual Checker | Followers and Following contain different synthetic inventories, with ten known mutuals. Same-profile counter links distinguish lists by visible text. A scrolling list recycles rows with duplicate avatar/name anchors and mixed-role controls. The scan must retain every window and the three comparison categories must match the separate inventories. |
| Incomplete capture | A truncated Following list exposes nine of sixteen accounts. The captured inventory must remain explicitly incomplete. |
| Loaded insights | The profile grid shows four of eight modeled posts using profile-prefixed post links containing images. The downloaded report must contain those four identities, report sample coverage, and make no extra network request. |
| Settings and reload | Theme and density persist across an actual page reload. An old global action unlock is never restored. |
| Presence review | Cancel performs no native action. A finite Like session uses the observed DIV rolebutton and nested SVG naming structure and changes exactly the reviewed number of separate post records. |
| Live like me | A continuous run likes six additional posts, crosses the former five-action boundary, pauses without further actions, resumes, and stops without duplicates. |
| Follow and requests | Native Follow and incoming-request controls update their own relationship records. The product must verify those outcomes. |
| Account binding | Changing the independently rendered signed-in account after review must prevent the previous approval from dispatching. |
| Stories | Three full-size media slides share an ID-less native story route. Viewing must advance the slides without inventing extra views or reactions. |
| DM Unsend | A delayed native message menu and confirmation remove only the independently newest sent message. Received messages remain intact. |
| Campaign Unfollow | A stored, due synthetic campaign is reviewed through the product UI. Stop after opening Following but before a delayed native Unfollow dialog must prevent the mutation. A separate fresh review must then complete exactly that Unfollow and record its verified campaign outcome. |
| Ghost Mode | The existing worker integration fixture opens real isolated renderer windows and uses real Web Locks. Twelve synthetic conversations run in ten-then-two groups; workers recover from inbox redirects, remove each sent message once, preserve received messages, and close every group before the next opens. |

The worker gate reuses `scripts/lib/userscript-ghost-workers-acceptance.mjs` and
its native inbox fixture. Its model is separate from the single-tab sandbox.
This retains the existing multi-window transport assertions instead of replacing
them with a simplified one-window imitation.

## Evidence

Each run writes:

- `test-results/instagram-sandbox/report.json`, including the exact userscript
  SHA-256, passed gates, failures, allowed and denied requests, renderer errors,
  independent state snapshots, and explicit fidelity limits.
- `test-results/instagram-sandbox/reports/`, preserving timestamped JSON reports.
- Comparable screenshots and failed-state screenshots.
- `test-results/instagram-sandbox/userscript-ghost-workers/result.json`, when the
  worker gate runs, with the opened paths, tab events and independent outcomes.

Browser profiles and captures stay inside the project's ignored test output.
No real exports or personal session data belong in this fixture or its evidence.

## What the evidence proves

The retained 4.3.1 read-only native observation records inbox rows implemented as
buttons without thread links. Its regression fixtures model inbox startup
redirects that lose the original worker URL. Other existing native fixtures model
ID-less messages and virtualized lists. These are different evidence levels; see
[`acceptance/4.3.1.md`](acceptance/4.3.1.md) and the existing native browser fixtures.
The sandbox reconstructs those contracts with authored synthetic markup; it does
not copy Instagram's proprietary implementation.

On November 9, 2026, read-only inspection of an authenticated session observed
current feed, profile, follower-dialog and inbox
structures. The fixture now includes DIV rolebutton feed controls named by nested
SVGs, rolebutton story tiles, same-profile counter links, profile-prefixed post
grid links, duplicate avatar/name list anchors, mixed-role row controls, native
inbox navigation and comma-separated dark RGB custom properties.

The sanitized contract inventory is
[`instagram-sandbox.provenance.json`](../tests/fixtures/instagram-sandbox.provenance.json).
No real usernames, account counts, post IDs, message bodies or session values are
included. Public served client scripts were also inspected, but no Instagram
client code was reused. Structural inspection did not execute a real Follow,
Like, Unsend or story view, and no conversation was opened for this inspection.

The full story viewer, message bodies and menus, worker recovery, fixture visual
layout, account inventories, delays and server outcomes remain retained or
authored assumptions. Current read-only DOM observations do not validate those
native mutation outcomes or establish backend parity.

A passing fixture result proves the exercised production behavior against these
contracts. It cannot prove current selectors across Instagram experiments,
localization, real pagination, real server persistence, rate limits, anti-abuse
decisions, authenticated batch removals, or actual account outcomes. Keep a
separate authenticated acceptance record for those checks. Do not label this
fixture “one to one,” “scraped Instagram,” or proof of all live compatibility.
