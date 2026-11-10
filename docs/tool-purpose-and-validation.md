# Tool purpose and validation

Insta Toolbox helps someone review relationships, carry out chosen Instagram
activities, and clean up their own messages. A tool succeeds when the person can
understand its scope, choose the intended target, finish or stop the work, and
trust the result. A running indicator or a click count does not establish success.

The userscript is the active product. The extension, PWA, and desktop packages
remain available on their existing 4.3.1 channel; they do not expose identical
workflows. In particular, the userscript has three tabs: **Mutual Checker**,
**Presence**, and **DM Unsend**. **Live like me** is a Presence run style.

## Why each tool exists

| Tool and entry | Why someone uses it | Purpose and successful outcome | What the result does not establish |
| --- | --- | --- | --- |
| Mutual Checker | Understand the overlap between an account's followers and following. | Read both lists, identify mutuals and unmatched captured accounts, then let the person search or download the comparison. Show list completeness and account identity alongside the result. | An account missing from a partial list is not a proven non-mutual. |
| Capture lists and export, in Mutual Checker | Keep or inspect the accounts already available in a native list when a full read is unavailable. | Accumulate unique accounts across rendered windows, distinguish added rows from duplicates, and export the captured evidence. Clearing the draft must be deliberate. | Captured DOM rows are not necessarily the complete list or a fresh server inventory. |
| Profile and content insights, in Mutual Checker | Make a useful summary of posts already loaded on the page. | Report the sampled posts, known media types, linked hashtags, and attributable dates; provide text and JSON exports. Unknown fields remain unknown. | This is not account analytics, complete history, engagement attribution, or proof that a hashtag link belongs to the post author. |
| Presence: One session | Perform a finite set of explicitly chosen native activities without repeating each interaction manually. | Preview the selected activity types and action goal, verify the account, request confirmation, run at normal spacing, and show verified progress, skips, the final reason, and an activity log. | Selecting an activity does not guarantee that Instagram has an eligible target available. |
| Presence: Live like me | Continue the activities the person selected for a chosen duration. | Repeat only those activities until the duration ends or the person pauses or stops. Explain the end condition and next wait, preserve visible control, and distinguish confirmed work from attempts. | It does not learn the person's tastes, imitate past behavior, run with the browser closed, guarantee uninterrupted operation, or promise account growth. |
| Grow through mutuals, in Presence | Review potential connections related to accounts the person already follows. | Use one to three selected seeds, rank available candidates, let the person review exact follow targets, and record verified campaign follows. Later, offer due unfollows for a fresh review after the chosen wait. | Shared connections do not guarantee relevance or follow-back. A stored campaign never authorizes future unattended unfollows. |
| DM Unsend | Remove messages the person sent in the conversation they chose. | Confirm the exact conversation and scope, discover eligible sent messages across virtual windows, remove each through native controls, verify removal, and keep received messages untouched. Report unknown outcomes separately. | Opening a menu, dispatching a click, or a row disappearing optimistically is not proof of removal. |
| Own reaction cleanup, in DM Unsend | Remove the person's reactions without deleting the received messages they reacted to. | Offer a separate finite review or an explicitly selected follow-up pass, bind approval to the account and thread, verify each own reaction removed, and keep its totals separate from Unsend. | A visible reaction badge alone does not prove that the signed-in account owns the reaction. |
| Ghost Mode, in DM Unsend | Apply reviewed message cleanup across available conversations. | Discover conversations, communicate partial discovery, confirm the selected scope once, process managed groups of up to ten tabs, reconcile verified and uncertain results, and make Stop available in the manager. | Available conversations are not automatically a complete inbox. A new tab, loaded iframe, or fixture result is not proof of an authenticated removal. Opening conversations may mark them read. |
| Settings, layout, and activity log | Make the tool usable and keep understandable records without accidentally restoring old authority. | Persist appearance and supported defaults, support keyboard and narrow layouts, expose task-specific error recovery, and allow private log export or clearing. | Saved preferences and resumed UI state do not authorize a new live action. |
| Workspace, in the held PWA or desktop app | Work locally with Instagram exports, comparisons, reviewed plans, and ledgers. | Review and import supported data, preserve account identity and migrations, search and compare it, and export usable results. Keep the paired action boundary explicit. | The workspace is not an authenticated Instagram worker and does not make the held packages the active update channel. |

The userscript's reviewed growth batches and Presence activities contain its
current account-action flows. A standalone legacy Follow / Unfollow composer is
not exposed as a fourth userscript tab. Retained handlers or older extension
screens must not be described as a new userscript feature without exercising an
actual entry point.

## Validation contract

Each test must name its input, independent expected state, actual product entry,
observable result, and evidence level. Preserve the same checks when correcting
the implementation or the harness.

| Surface | Required task proof | Important failure and recovery cases |
| --- | --- | --- |
| Lists and comparisons | Account-bound unique inventory, true overlap, truthful completeness, usable search and downloads. | Empty, partial, virtualized, duplicated or conflicting identities; account change; request failure; rate-limit wait and Stop. |
| Insights | Known fixture posts independently match the report and export; missing fields stay unknown. | No loaded posts, ambiguous post identity, duplicate posts, comment hashtag links, unbound timestamps, and inbox route. |
| Presence and Live like me | Confirmed activity matches the selection and signed-in account; one session respects its goal; Live respects its duration; Pause and Stop settle correctly. | No eligible activity, skip versus verified counts, expired approval, failed confirmation, account or route change, delayed timers, interruption, and restart without authority. |
| Growth | Displayed exact targets match independent list truth, approval, ledger, and later due-review rules. | Incomplete seed lists, duplicate candidates, changed selection or account, expired review, failed or uncertain follow, and premature unfollow. |
| DM and own reactions | Independent fixture state proves only eligible own messages or reactions were removed; received content remains. | Long or short threads, virtualized and recycled rows, id-less messages, delayed menus, optimistic reversal, wrong thread, cancellation, and ambiguous ownership. |
| Ghost Mode | Manager discovery and each worker's independent state agree; groups close in order; total verified and unknown outcomes reconcile. | Inbox redirects, missing launch fragment, partial discovery, request folders, expired authority, worker crash, Stop during navigation, and recoverable checkpoint. |
| Interface and persistence | A first-time and returning user can complete the chosen task at desktop, 320 CSS pixels, and true 200% zoom, in both themes, with keyboard controls. | Disabled actions with reasons, focus trapping and restoration, hidden or clipped controls, reload, account switch, loading/error feedback, unexpected console errors, and stale data. |
| Held workspace | Synthetic exports import, migrate, compare, search, and export without private network delivery. | Malformed archive, unsupported data, duplicate import, storage failure, migration interruption, and identity reset. |

## What each kind of evidence proves

1. **Source or unit tests** prove the exercised contracts with their supplied
   inputs. They can expose mechanism defects, but do not prove browser layout,
   current Instagram markup, or server outcomes.
2. **Local browser fixtures** run the generated userscript and real UI controls
   against synthetic native-page behavior. Assert outcomes against fixture state
   that the product cannot set itself. Include delays, virtualization, route and
   account changes, restrictions, and interrupted jobs.
3. **Observed Instagram interface** records what the currently accessible page
   actually exposes. Record the observation date and which structural features
   were reproduced. Keep private bodies, usernames, identifiers, session state,
   and assets out of distributable fixtures.
4. **Authenticated acceptance** runs the same task on an authorized disposable
   target and independently verifies its final native state. Keep attempted,
   dispatched, verified, and uncertain outcomes distinct.
5. **Human acceptance** requires actual user feedback. Automated coverage and a
   reviewer's visual judgment cannot supply it.

A reconstructed sandbox is a contract model, not a one-to-one clone of
Instagram's service. Served client code and markup do not include every backend
rule, experiment, account-specific surface, or future change. Record observed,
inferred, and missing behavior rather than claiming equivalence. Fixture success
and live compatibility remain separate verdicts.

## Repeatable checks

```sh
pnpm run assemble
pnpm test
node scripts/build-userscript.mjs
node scripts/run-instagram-sandbox.mjs
pnpm run qa:extension
pnpm run qa:background
pnpm run qa:chrome
pnpm run qa:overlay:check
pnpm run qa:browser:check
pnpm run verify:repo-hygiene
```

The [Instagram sandbox](INSTAGRAM_SANDBOX.md) records its independent state
assertions, generated-script hash, and coverage limits. Run it when changing
native-page contracts. Preserve existing screenshot baselines and
tolerances. Review changed captures directly; a clean test count is not a visual
or live-acceptance verdict.
