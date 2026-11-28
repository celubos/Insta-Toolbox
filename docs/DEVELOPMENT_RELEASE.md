# Insta Toolbox 4.3.10 development build

Version **4.3.10** is the latest development build. The latest published stable
release remains [4.3.1](https://github.com/celubos/Insta-Toolbox/releases/tag/v4.3.1).
The development userscript is available for testing; it has not been promoted
to the stable release channel.

## Install or update

1. Install [Tampermonkey](https://www.tampermonkey.net/) and enable **Allow User Scripts** in Chrome's extension settings.
2. Open the [commit-pinned 4.3.10 userscript](https://raw.githubusercontent.com/celubos/Insta-Toolbox/80e0d56c56b9dfc158327576ed9163c75c85e22b/userscripts/insta-toolbox.user.js). Choose **Install**, or **Update** if Insta Toolbox is already installed.
3. Reload Instagram and open **IT**. Keep one Insta Toolbox copy enabled.

The pinned file is **883,562 bytes**, SHA-256:

`4ebff034cd80b325d03e04a064137a484b14115e98e6330009ef3198d1fd07f6`

For the stable version, follow the [standard installation guide](INSTALLATION.md).
Existing userscript identity, author and stable update URLs are preserved.
Extension, desktop and web/PWA downloads remain on their held 4.3.1 channel.

## Changes since 4.3.1

- **Presence history:** retain account-scoped activity across tabs and acknowledge storage writes. Discovered history stays explicitly partial.
- **Native lists:** avoid repeatedly searching list avatars for account navigation, and preserve partial-result labels when native counts disagree.
- **Ghost recovery:** save bounded conversation observations before opening the next chat. After a page reload, **Restore found conversations** recovers a partial list for the same verified account. Names may have changed. Select exact threads and review again; previous selections, approvals and native message evidence are discarded.
- **Stop and expiry:** cancel pending recovery and reject expired or changed-account reviews. Recovered results require managed workers that verify the account, thread and message ownership again.

See the [changelog](../CHANGELOG.md) for the version history and the
[source changes in PR 79](https://github.com/celubos/Insta-Toolbox/pull/79).

## Verification and remaining acceptance

The exact candidate at
[80e0d56](https://github.com/celubos/Insta-Toolbox/commit/80e0d56c56b9dfc158327576ed9163c75c85e22b)
passed:

| Check | Result |
| --- | --- |
| Source tests | 1,442 passed, no failures or skips. |
| Package and control paths | 36 passed. |
| Native browser, sandbox and background | 50, 15 and seven checks passed. |
| Rendered states | 45 overlay and 11 PWA states passed; existing baselines and tolerances unchanged. |
| GitHub CI | All eight exact-candidate checks passed. [CI run](https://github.com/celubos/Insta-Toolbox/actions/runs/42913776341). |
| Download identity | The pinned userscript, CI artifact and local file have the same SHA-256. |

The browser test replaces the coordinator document, restores observations
without selection or approval, then completes a freshly approved twelve-thread
synthetic run while preserving received messages. Fixtures model interface
contracts; they do not reproduce Instagram's backend.

Installed 4.3.10 activation, recovery and remaining live action acceptance are
still pending. Earlier live results retain their original versions: the full
377-activity timed Presence run belongs to 4.3.8; list scans, Presence controls,
history retention, sampled Insights and one approved message removal belong to
4.3.9. These results do not establish full 4.3.10 live acceptance.

Official publication remains held until the required live checks and protected
current-main artifact promotion pass. The protected release workflow remains
required.
