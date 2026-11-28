# Insta Toolbox 4.3.11 development build

Version **4.3.11** is the latest development build. The latest published stable
release remains [4.3.1](https://github.com/celubos/Insta-Toolbox/releases/tag/v4.3.1).
The development userscript is available for testing; it has not been promoted
to the stable release channel.

## Install or update

1. Install [Tampermonkey](https://www.tampermonkey.net/). In Chrome 138 or newer, enable **Allow User Scripts** in Tampermonkey's extension details; older Chrome and Edge use Developer Mode.
2. Open the [commit-pinned 4.3.11 userscript](https://raw.githubusercontent.com/celubos/Insta-Toolbox/a7a27b9fa5ad6550c6382c4234d96e814e773375/userscripts/insta-toolbox.user.js). Choose **Install**, or **Update** if Insta Toolbox is already installed.
3. Reload Instagram and open **IT**. Keep one Insta Toolbox copy enabled.

The pinned file is **875,564 bytes**, SHA-256:

`4a141be512e60413b908403e4bb981bcd0afa5374b6da0f0001f7c6ee4c87740`

Tampermonkey checks the stable release URL for updates. A development build
does not update itself to a later development build; reopen this page instead.
For the stable version, follow the [standard installation guide](INSTALLATION.md).
Existing userscript identity, author and stable update URLs are preserved.
Extension, desktop and web/PWA downloads remain on their held 4.3.1 channel.

## Changes since 4.3.10

- **Mutual Checker:** Instagram retired both account lookups the checker used;
  they now return HTTP 404 for every session. Your own account is checked
  through the still-working list route again, bound to the signed-in account
  only when Instagram's rendered viewer record and the visible navigation
  agree. Run it from your profile to confirm totals; elsewhere results stay
  partial and say so. Other accounts still use their open profile.
- **Signed-out tabs:** report that no signed-in account is shown instead of an
  account change.
- **DM Unsend:** restored to the exact 4.3.9 code (last verified live removal);
  the 4.3.10 Restore found conversations change is withdrawn.

## Changes since 4.3.1

- **Presence history:** retain account-scoped activity across tabs and acknowledge storage writes. Discovered history stays explicitly partial.
- **Native lists:** avoid repeatedly searching list avatars for account navigation, and preserve partial-result labels when native counts disagree.

See the [changelog](../CHANGELOG.md), [4.3.11 acceptance](acceptance/4.3.11.md)
and [4.3.11 compatibility](compatibility/4.3.11.md).

## Verification and remaining acceptance

The live failure was reproduced on installed 4.3.9 on November 27, 2026, and
the repair was written against those observed routes. Seven live-derived
regressions fail on 4.3.10 and pass on 4.3.11. Full local and CI results for
the exact candidate are recorded in its pull request.

Installed 4.3.11 activation and live acceptance are pending. Earlier live
results retain their original versions: the full 377-activity timed Presence
run belongs to 4.3.8; list scans, Presence controls, history retention, sampled
Insights and one approved message removal belong to 4.3.9.

Official publication remains held until the required live checks and protected
current-main artifact promotion pass.
