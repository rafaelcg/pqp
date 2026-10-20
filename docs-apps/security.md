# Security

The threat model in one sentence: **an app is hostile code running next to somebody's account, and everything about the design assumes that.** This page says what is defended, how, and what is still open. The [sandbox](/concepts/sandbox), [bridge](/concepts/bridge) and [privacy](/concepts/privacy) pages are the long form.

## What an app is assumed to try

- Reading or changing the pqp page around it, its cookies, its storage or its other frames.
- Learning who people are beyond what the session gives it: user ids, emails, which server or channel it is in.
- Sending data out: a request, a beacon, a navigation to an address with the data in it.
- Flooding the page, the server or the other people in a session with messages or state.
- Lying to the page with malformed or oversized messages.
- Looking different after review than during it.
- Being embedded and probed from somewhere else.

## The defences, by what they stop

| Attack | Stopped by |
|---|---|
| Touch the page, cookies, storage | `sandbox="allow-scripts"` with no `allow-same-origin`: an opaque origin; and a bundle on a separate, cookieless site. |
| Make a request | A content security policy with `connect-src 'none'` and `default-src 'none'`, generated per bundle. No manifest knob for the network. |
| Navigate itself out with data in the URL | A `frame-src` policy added to the **page** (CSP inside the frame cannot stop self-navigation), tested in Chromium, WebKit and Firefox. The frame is removed if it loads a second document. |
| Learn identities | The bridge schemas have no field for them, the page builds each participant from scratch, and a test fails if a user id, email, token, server id or channel id appears in a bridge schema. |
| Flood | Per-person event and state rate limits, size caps on the merged state, a flood bucket that answers without parsing and ends the frame if it persists, a participant avatar budget. Enforced on the page **and** the server. |
| Malformed messages | A strict schema on every message from the app: an unknown key or wrong type is `invalid`. |
| Change after review | A version's bytes are immutable: the build fails if a released `(id, version)` changes, the server refuses a catalog entry whose hash changed, and the entry's hash covers the integrity hashes of its script and stylesheet. |
| Be framed elsewhere | `frame-ancestors` lists only pqp's origins. |
| Trick the loader | The server builds every bundle address from the stored manifest, never from a request. An `assets` URL anywhere but the apps origin is refused without a request, a redirect is an error, and every asset is hash-checked. |
| Fake a theme or a name | Theme tokens are an allowlist read from the page's own tokens, at most 64. Names are cleaned of control and bidirectional characters. Avatars are fetched only from pqp's own origins, with a byte limit. |

## Residual risks

Said plainly, because a security page that lists none is not credible.

- **The `frame-src` policy is page-wide.** Because the page's policy has to allow the origins pqp already embeds (YouTube, Twitch, TikTok, Instagram, Cloudflare Turnstile), a hostile frame could navigate to one of those with a query string. Those hosts have no redirect to a destination the sender picks, so the data would land in a vendor's logs and not with the app's author. A structural fix (the frame in a wrapper document whose `frame-src` is the apps origin alone) is a follow-up decision.
- **WebKit opens a TCP connection for `<link rel=preconnect>` despite the policy.** That is a connection to a host the app chose, and a hostname can carry a few bytes, so it is a narrow way out in WebKit. It was found in the spike that shaped the sandbox and is recorded in the internal notes as open.
- **Review is people reading.** The checklist covers the sandbox, the network, the license, the copy and the presence line. A reviewer can miss something, which is why the technical walls do not depend on it.
- **An app can be annoying within its limits.** It can draw a loud screen, use its allowed rate of events, or be a bad game. Moderators and server owners can end a session or turn an app off, and an operator can turn it off everywhere.
- **Third-party apps do not exist yet.** Every app today is written by the pqp team and merged into the repository. The model above is what a third-party submission would be held to, and the review process for strangers is not built.

## Reporting a problem

The repository has no `SECURITY.md` yet. Until it does, use GitHub's private vulnerability reporting on [rafaelcg/pqp](https://github.com/rafaelcg/pqp/security) if it is switched on for the repository, and otherwise open an issue that says you have a security report **without the details**, and ask for a private way to send it.

## Where it is tested

- `packages/shared/src/apps/bridge.test.ts`: no identity key in any bridge schema.
- `client/e2e/app-frame/`: the real frame controller, bridge host and SDK in a sandboxed frame under the production policy, in Chromium, WebKit and Firefox, against a canary server.
- `tools/apps-build/src/*.test.mts`: deterministic output, the CSP, the refusals (inline script, `style=`, `on*=`, `<base>`, and so on).
- `packages/app-sdk/src/*.test.ts`: the handshake and every call against a fake host on a real `MessageChannel`.
