# Security review

Last reviewed: 2026-11-10

## Boundaries

Insta Toolbox is local-first. The PWA and desktop app process selected files and saved workspace data on the local device. The Instagram companion uses the session already active in the browser tab. It does not request a password, read or export cookies, send analytics, or use a remote control service.

Required extension host access is limited to Instagram. Pairing requests optional access only to the approved workspace origin; requests are signed, short-lived, nonce-protected, and split into read and action permissions. Sender origin comes from browser metadata, not the page's claim. Credential-like bridge fields are rejected.

Workspace exports can contain imported account data and pairing secrets. Treat them as private backups. Revoke pairings before sharing a backup.

## Action authority

There is no global live switch, persistent arm state, or typed authorization phrase. Dry runs cannot reach the page-control activator.

Every Follow, Unfollow, or Unsend mutation requires:

1. an exact reviewed target or thread and scope;
2. an action-specific confirmation;
3. a short-lived capability bound to that reviewed material;
4. reservation before page control;
5. revalidation immediately before each click;
6. a verified postcondition before a success ledger entry.

Capabilities expire and cannot be replayed. Route changes, panel closure, Stop, challenge, block, rate limit, wrong target, pre-existing dialog, ambiguous controls, or an uncertain postcondition stop the run. Failed preflight and zero-click failure record zero removals.

The in-overlay confirmation controller freezes the reviewed binding, focuses Cancel first, and accepts only a trusted browser click on its exact Confirm button. Synthetic `.click()` and dispatched events do not mint authority. Rendered facts use text nodes rather than HTML interpolation.

Account and message mutations retain the sole isolated live-control activator.
The native relationship reader has two separately reviewed navigation call
sites: opening the exact profile list and closing that same list dialog. Each
checks the current account, owner and dialog immediately before clicking.
These reads cannot invoke the live activator or grant mutation authority. The
extension package gate rejects extra direct click paths or missing native
context checks; full source checks run this gate alongside generated userscript
verification. Regression tests cover those rejections.

Thread-wide DM Unsend has an internal runaway watchdog, not a daily action limit. Version 3 does not read, migrate, or delete version 2 browser or desktop state.

## Follow and Unfollow

An account run is bound to a reviewed action, finite count, target list digest, and expiry. Each profile navigation revalidates the exact profile header and its owned relationship control. A pre-existing dialog stops the run. Unfollow accepts only the newly surfaced confirmation that names the reviewed account. Duplicate controls or a changed relationship stop before another action.

The userscript may retain the original run expiry across navigation through tab-scoped manager storage. It does not put action authority in shared userscript storage. A manager without the required tab-scoped API keeps account batches disabled.

## DM Unsend

Thread-wide Unsend binds a versioned plan to the exact open thread, scope (`all`, `newest`, or `oldest`), optional finite limit, digest, and expiry. After one confirmation it performs one streaming traversal; a read-only mounted-row count is not authorization. Version 3 and compatible version 2 plans use the restored Standard pacing only. Fast preferences normalize to Standard; stale Fast plans are rejected.

Before each removal the runner rechecks:

- the exact `/direct/t/<id>` route;
- expiry and Stop state;
- proof that the message was sent by the current user;
- one newly surfaced, interactive Unsend menu item;
- one newly surfaced matching confirmation dialog;
- verified message removal in the same thread.

The traversal handles virtualized rows, normal and reversed layouts, scroller replacement, DOM shrinkage, bounded retries, and stable-empty exhaustion. Successful actions use adaptive one-to-two-second pacing. The runner records only verified removals and never reports the mounted DOM window as the conversation total.

The restored runner retains bounded menu readiness and adaptive 1–2 second successful-action pacing. Nested right-aligned controls cannot establish message ownership; contradictory ownership evidence stops preflight. Changed preview text, temporary loading states, recycled row identities, and optimistic removals that revert are not success evidence. Removal must remain proven through the bounded settlement window.

Page freeze and page exit revoke current action authority. Already-dispatched removals settle as verified or uncertain; the next mutation is not dispatched. Resuming the page does not restore authority. Ordinary focus changes do not themselves revoke a run, but reliable inactive-tab execution still needs separate acceptance. Waits release listeners, observers, and timers on settlement.

Extension managed-tab modules are not registered for live execution. The
userscript's reviewed Ghost adapter opens groups of ten exact worker tabs; selected
cleanups may use smaller groups. A group finishes and closes before the next opens.
Tabs prepare concurrently, but mutations remain serialized through one account lane
and one pacing clock. Worker messages cannot restore action authority; manager
loss, wrong context, expiry, restrictions, storage failure, or uncertainty stop
new work. Fixture results do not establish crash-safe external execution or
current authenticated Instagram compatibility. The optional own-reaction
follow-up remains separately scoped and requires verified outcomes.

Visible DM evidence is scoped to the exact open thread. Navigating to the inbox, feed, a profile, or a different thread hides and clears previously exposed candidates.

## Mutual Checker

Mutual Checker is the narrow authenticated-read exception. It can call only these same-origin GET routes:

- `/api/v1/web/search/topsearch/`
- `/api/v1/users/web_profile_info/?username=<exact-username>`
- `/api/v1/friendships/<numeric-id>/followers/`
- `/api/v1/friendships/<numeric-id>/following/`

The client uses browser-managed credentials without reading them, a fixed application header, bounded pagination, paced requests, a 20-minute deadline, and user cancellation. The profile response must repeat the exact normalized username and numeric ID. Complete results require exact total equality and stable totals before and after traversal. Login loss, challenge, block, rate limit, repeated pagination tokens, invalid schemas, conflicting totals, and request failures leave the result incomplete or stop the scan.

If the fixed search lookup returns HTTP 404 or 410, resolution may use the already listed profile GET instead. The exact requested username and every supplied numeric `id`/`pk` must agree before a list is read. That bound response supplies the initial counters without a duplicate metadata request; final counter verification remains fresh. This fallback does not apply to authentication, restrictions, cancellation, identity conflicts or other response failures, and does not introduce another endpoint or a POST request.

Results replace Followers and Following atomically and are not sent through the extension bridge. Instagram can change these unsupported web routes without notice.

When both lookup GETs explicitly return HTTP 404 or 410, the userscript's
primary check can read the exact open profile's native Followers and Following
lists. It requires a unique owner header, scoped count controls, a newly opened
matching dialog, stable account evidence and fresh ending totals. Its narrow
backdrop verifier re-reads the rendered account rail while that exact list
dialog hides the app from accessibility; ordinary viewer visibility stays
strict. Native results retain list-dialog provenance and do not invent numeric
IDs or authenticated API evidence. Interruption leaves the saved comparison
unchanged and offers observed partial rows as a separate download. Other
engine callers do not enable this fallback by default.

Provenance-verified partial comparisons remain visible and downloadable with uncertainty and “Not found” wording. They may supply reviewed Follow / Unfollow targets under the existing 3.1.12 contract, with uncertainty bound into review and confirmation; missing records are not presented as confirmed relationship facts. A quiet or motionless list does not establish completion. Schema 6 retains earlier rows but clears unproven completion from older dialog captures. Existing count-verified authenticated captures remain usable.

## Local app and web delivery

The PWA service worker uses network-first same-origin GET handling, caches only successful same-origin responses, bypasses the HTTP cache for service-worker update checks, and removes earlier cache generations. Version 4.1.4 used `insta-toolbox-v414`; the 4.3.10 preparation uses `insta-toolbox-v4310`. Persisted workspace and settings keys are unchanged. Public web/PWA delivery remains on hold at 4.3.1.

The loopback development server accepts only loopback Host headers and serves an explicit asset allowlist. Repository metadata, tests, documentation, and Git internals are not served. Framing protection is sent as HTTP headers because `frame-ancestors` is ineffective in a meta policy.

Running PWA jobs own an `AbortController` and immutable reviewed identity. Discard aborts only the matching run. Cancellation is checked around every awaited inspection, authorization, and reservation boundary. A job removed from storage cannot be recreated by a late callback. If a browser mutation was already dispatched, the adapter completes its postcondition check and records the observed result rather than calling it canceled.

## Desktop packages

The Windows installer is unsigned. SmartScreen trust is not claimed.

The universal macOS package is ad-hoc signed, not Developer ID signed or notarized. It currently needs `com.apple.security.cs.disable-library-validation` because the Electron bundle has no Developer ID Team ID. Package QA treats that entitlement as a disclosed exception and rejects other unexpected entitlements. It checks both `arm64` and `x86_64` slices, hardened-runtime flags, bundle contents, icon, signature, archive roots, and exact-app launch.

When release credentials are available, remove the library-validation exception, sign every nested binary with the release identity, notarize the artifacts, staple the ticket, and repeat the exact-package checks.

## Review history

Earlier reviews fixed structural profile-control binding, pre-existing-dialog confusion, missing extension reservations, malformed migration fields, discard races, weak message identity, unbound or noninteractive DM controls, synthetic confirmation acceptance, and incomplete oldest-edge traversal. Regression fixtures cover these boundaries.

Historical releases retain their own acceptance records. They are not evidence that the current 4.3.10 preparation passed authenticated acceptance. Current authenticated compatibility, human screen-reader use, Windows publisher trust, Apple notarization, and physical Intel Mac behavior require fresh acceptance.

## Dependencies and supply chain

Runtime application code has no third-party production dependencies. The lockfile keeps major-compatible patched `brace-expansion` releases and executable tests verify their expansion-length bounds.

CI actions are pinned to full commit SHAs. Pull requests receive dependency review; CodeQL runs on pull requests, `main`, and weekly. Dependabot proposes npm and action updates. Release promotion accepts only artifacts from the successful current `main` CI run, rechecks versions and checksums, generates an SBOM, and requests GitHub provenance attestation without rebuilding.

The historical 4.1.4 development matrix contained 1009 tests; its results remain
in [the 4.1.4 acceptance record](./acceptance/4.1.4.md).

The historical 4.3.3 candidate passed 1,275 source tests, 50 production extension
browser gates, 7 background gates, 15 sandbox journeys, 45 overlay states and
11 PWA states. Its production dependency audit found no known vulnerabilities,
and all eight candidate CI checks passed. Installed-build testing nevertheless
found that a native dialog could be scanned before its initial rows loaded;
authenticated acceptance failed and no official release was published. See
[the 4.3.3 acceptance record](./acceptance/4.3.3.md) for that evidence.

The historical 4.3.4 candidate passed 1,280 source tests, 31 package safety tests,
45 overlay and 11 PWA states, and all eight candidate CI checks. Installed-build
testing found that a clipped pagination loader stalled initial native reading
despite available rows and a scroll container. Its bounded timeout preserved
the saved comparison, but native comparison acceptance failed and no official
release was published. See [4.3.4 acceptance](./acceptance/4.3.4.md).

The 4.3.5 candidate starts collection from verified rows and their actual scroll
container. Native loader visibility also checks dialog, overflow and viewport
clipping; visible loaders still prevent unproven completion. Exact empty-list
and final-count safeguards, cancellation and manual defaults remain unchanged.
Growth drafts retain a native loading-timeout reason only as partial evidence,
without creating candidates or action authority. Assembly succeeded; the source
suite passed 1,286 tests, package safety passed 31 tests, and rendering passed
45 overlay and 11 browser/PWA states with unchanged images and tolerances.
All eight candidate CI checks passed. Selected installed Insights and
diagnostics exports were checked. A configured up-to-30-minute workload expired
naturally with six story activities and no verified post Like. Primary timeout
recovery preserved the saved comparison; complete comparison and Growth draft
restoration did not pass. The full live matrix remains incomplete in
[the 4.3.5 acceptance record](./acceptance/4.3.5.md).

The 4.3.6 repair matches only full canonical post/reel paths for post-Like
identity. Nested music/audio routes cannot create a second identity; audio-only
articles, conflicting canonical IDs and duplicate Like controls stay
ineligible. Existing context, authority and verified-outcome checks remain
unchanged. Growth now retries only read-only saved seed-draft restoration once
after delayed account verification, through the existing observer and bound to
the initial route, actor and fresh Following basis/digest. Edits, work, busy
state or drift cancel it; seed reads and action approval are never restored
automatically. Both code changes passed independent review; Growth restoration
passed 51 focused cases, including intervening busy-state cancellation.
The final generated build passed 1,297 source tests, 31 package safety checks,
50 browser gates, 15 sandbox journeys, seven background cases and 45 overlay
plus 11 PWA states with unchanged baselines. All eight candidate CI checks and
activation passed. Three native post Likes were verified, and the full
95-record live history retained all prior records. A later cold mount failed
to expose the history UI after delayed account verification. Synthetic
regressions reproduced conditional overwrite and cross-account scope risks;
neither was observed in the preserved live history. See
[4.3.6 acceptance](./acceptance/4.3.6.md).

Installed 4.3.6 cold navigation also restored a three-seed read-only Growth
draft. The subsequent explicit native read stopped with zero accepted rows
while the new Followers dialog was still unlabelled and the account rail was
behind its backdrop. Later fully loaded markup did not validate that stopped
attempt. No Follow ran. Draft restoration passed; seed reading did not.
A later native probe also found a typed Following dialog at zero opacity
during its initial fade, with the account rail and header behind the backdrop.

The 4.3.7 history component hydrates only verified account history and binds
each logger and reviewed run to that original scope. Its 63 focused cases and
independent review passed; the shared queue, sanitization, 500-entry bound,
storage keys, schema and grants remain unchanged. Clear rechecks its displayed
account before and after confirmation; late writes retain their original key.

The implemented native-opening guard captures strict fresh account navigation,
owner header, route, exact counters/control, current restrictions and
no-existing-dialog proof before the native click. It can wait only for that
single newly opened, retained dialog, with original nodes rechecked each time.
Zero opacity is tolerated only on that mounted dialog during opening, never
on account controls or ancestors. Opening classification uses rendered text
without a fallback to non-rendered SVG titles. Default Viewer stays strict.

Opening and initial row readiness share the existing 20-second deadline;
Growth retains its four-minute seed budget. The opening phase grants no
mutation authority and performs no account-scoped draft/campaign storage IO.
Full visible scoped viewer and stored-draft continuity checks resume before
rows, the next list or result persistence. Stop, restrictions and account,
profile, route, count/control or dialog drift fail closed.

Both repairs passed independent review. Native-opening and existing Growth
regressions passed 138 checks, including 45 new cases; seven control-path
checks passed. Generation completed with a userscript size of 839,917 bytes
and SHA-256 `fdc093f238a25410dbcd262823f8a2a33b5796d1c83f224c6f2a76d55884880c`.
All local checks passed on these same generated bytes: 1,353 source tests
with zero failures or skips, 31 package checks, 50 native browser gates,
15 sandbox journeys, seven background cases, 45 overlay states and 11 PWA
states. Reviewed visual baselines and tolerances are unchanged. The production
dependency audit reported no known vulnerabilities.
All eight exact-candidate 4.3.7 CI checks passed, and the userscript checksum
matched. Installed activation and cold read-only history retention passed;
broader live acceptance and current-main promotion remain blocked in
[4.3.7 acceptance](./acceptance/4.3.7.md).
A later synthetic two-panel/session test confirmed inherited same-account
multi-tab history loss in 4.3.7: a cached later writer removed the previous
run's three new events. This behavior predates the account-scope repair; no
actual user history loss was observed and the preserved real records remain
intact. Hold the 4.3.7 update. Its passing matrix does not establish multi-tab
retention. Installed 4.3.7 Settings and its single userscript host were
verified; a cold read/export retained all 95 prior records with no Start,
Clear or social writes. A later Growth seed read failed before rows when
Instagram replaced its empty opening dialog with a typed list in the same
portal. No complete Growth or all-tools acceptance is claimed.

Version 4.3.8 implements the private history repair and async UI, independently
reviewed with 85 combined focused checks. The bounded native skeleton handoff
passed independent review and 209 focused regressions without granting action
authority during opening. The generated candidate passed all required local
gates and all eight candidate CI checks. Installed activation, timed Presence
and cold history retention passed; native list stalls keep full acceptance held in
[4.3.8 acceptance](./acceptance/4.3.8.md).

The approved private-manager journal uses independent immutable operations and
confirms writes only after acknowledgement. Its discovered confirmed view
can lag other tabs; no globally fresh discovery claim is made. Clear fences
observed and older/concurrent waiting activity upon discovery. New entries
created after a tab observes the fence can be logged normally. The legacy V1
private backup is retained, and later legacy import is quarantined after
Clear; logical clearing is not a promise to erase every physical backing key.
Display and export retain at most 500 entries. Cleanup work is bounded to
32-record batches, not a global physical-key cap.

Userscript metadata adds only GM.getValue, GM.setValue, GM.listValues and
GM.deleteValue for this userscript's own private manager storage, preserving
all legacy grants. No @connect, network, cookie or domain permission is added.
Identity, author, stable URLs and action authority are unchanged. The dedicated
history module consumes the existing activity normalizer through a separate
optional backend; wiring must preserve that boundary without a circular import.
History implementation and UI review passed, including actual two-panel
serial-session retention of 101 records and late-outcome account isolation.
The native skeleton handoff review passed; complete same-build/live proof
remains pending.

Official release is also held because authorized maintainer dispatch and
review access are currently unavailable; existing protections remain required.
Fixtures do not prove current authenticated Instagram behavior.

Partial mutual comparisons are available for display, export, and Follow / Unfollow target review. Target reviews and their existing confirmation show an uncertainty notice; missing records are not proof of a non-mutual relationship. Captures must belong to the signed-in account, and each profile's current relationship is checked before acting. Schema-1 comparison exports preserve existing fields and add `partial`, `labels`, and `warning`; completeness flags are not promoted by downloading.

## 4.3.9 native-list performance boundary

Exclude native-dialog profile links before account-navigation geometry and
ancestor scans. Large lists no longer trigger one whole-list search per
avatar. Existing visible-navigation and explicitly scoped backdrop proofs
remain required; dialog rows never establish account identity. No permissions,
storage schema, review capability or live-action dispatch change is introduced.
Two new regressions and 222 neighboring checks passed. Installed list retesting
remains required; the 4.3.8 native stalls keep full acceptance held despite
its passing timed Presence, history and exact-candidate CI checks.
See [4.3.9 acceptance](./acceptance/4.3.9.md).

## License

The application is MIT licensed. Source provenance and third-party licenses are recorded in `THIRD_PARTY_NOTICES.md`. Release archives include the license and notices.

## 4.3.10 discovery recovery boundary

Only bounded thread observations and sanitized historical labels are written
to existing private tab storage. Account scope and the original discovery
deadline are rechecked after asynchronous reads and after confirmation. No
selection, approval token, native row/pane evidence or automatic start is
restored. Recovered results require managed workers and a fresh bound review;
workers retain their own exact account, thread and ownership checks. Stop
invalidates pending restoration. Expiry limits reuse rather than promising
physical storage erasure. No additional grants are requested.
