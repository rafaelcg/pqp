# Review and availability

Two separate questions decide whether people can run your app somewhere: **has it been reviewed**, and **is it switched on there**. This page is both.

## Review

Every version of every app is reviewed by a pqp operator, by hand, before it can go live. There is no automated approval.

A new version arrives with `review_status: pending` and moves to `approved`, `rejected` or `withdrawn`. The reviewer fills in a checklist, one line each, and may leave a note (up to 2 000 characters). The keys below are the ones the operator tooling records; the right-hand column is our plain reading of what each is for.

| Checklist line | What it covers |
|---|---|
| `sandbox` | Does the app stay inside the sandbox: no attempt to escape the frame, no use of anything the sandbox is meant to deny? Are the `sandbox` knobs in the manifest justified? |
| `noNetwork` | Does the app make no network request, and does it need none? |
| `license` | Is the declared license real and the source URL the actual source of this bundle? |
| `i18n` | Are `pt-BR`, `en` and `es` all present and written as people speak? |
| `presence` | Does the presence line read correctly, with the name in the right place? |
| `romPolicy` | Emulator apps only: is the policy for people's own files followed? |

An app cannot be `live`, or globally on, while its **current** version has not been approved. Moving the current version to an unreviewed one is refused. Every operator write is recorded in an audit log: who, what, before and after.

What review reads, in practice: your `manifest.json` (does what it asks for match what the app does), your source (the bundle is open source and linked from the manifest), and your app running. Beyond the checklist, an app that traps keyboard focus fails review, because the frame is one tab stop and the page never captures Escape. Emulators get extra review and are first-party only.

## Availability

Review answers "is this version fine". Availability answers "may it run **here, now**". An app runs in a place only when every gate holds, and the launcher shows the **first** one that fails, written on the tile:

| Reason | The gate |
|---|---|
| `flag-off` | The runtime flag `apps` is off for the server. |
| `not-live` | The app's status is not `live`, or it has no current version. |
| `global-off` | The operator's master switch for the app is off. |
| `not-allowed-here` | The operator has not enabled this app for this server. |
| `owner-off` | The server's owner turned it off. The owner can only remove what the operator allowed. |
| `community-locked` | The server is a public community and the app has no safety decision for communities. |
| `emulator-off` | Emulator apps also need the `emulator_room` flag on the server. |
| `channel-type` | The channel is a type your manifest does not list. |
| `no-origin` | The deployment has no apps origin, so no app can run anywhere. |

For you as an author this means three things.

1. **An approved app is not an app that is on.** Even after review, an operator switches an app on, then on per server. A new server is not given your app by default.
2. **Public communities are locked by default.** Every app stays off them until the operator records an explicit safety decision for that app, because a public community changes the legal category of the instance ([`docs/CONTENT_SAFETY.md`](https://github.com/rafaelcg/pqp/blob/main/docs/CONTENT_SAFETY.md) explains why). Apps with `content.userText` or `content.userImages` get the harder look.
3. **A running session is not affected by new releases.** It keeps the version it pinned. It *is* affected by a switch: an app being turned off is one of the reasons a session ends (`app-disabled`).

## Who may start one

The `USE_APPS` permission, which is on `@everyone` of every server created from now on and on the moderator, manager and admin roles. It is not in the default for communities, so a community has it only when its owner grants it. A manifest may also require `MANAGE_CHANNELS` to start.
