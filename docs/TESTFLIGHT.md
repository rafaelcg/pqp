# TestFlight (iOS beta)

How to offer the native iOS app via **TestFlight**, and what App Store Connect
means by **Sign-in information**.

The web CTA (“Join the iOS beta”) reads `VITE_TESTFLIGHT_URL` at build time. Until
that secret is set, the site links to `/vs-discord#ios-beta` with a short hint
instead of a dead join URL.

## What you already have

| Item | Status |
|---|---|
| Bundle ID | `gg.pqp.app` (`ios/project.yml`) |
| Team | `WXBFUF9WMA` |
| Version | Check `ios/pqp/Info.plist` (`CFBundleShortVersionString` / `CFBundleVersion`) — builds have already been uploaded manually |
| Release API | `https://api.pqp.gg` + live Clerk publishable key in Release config |
| Public App Store listing | Not yet |

## Sign-in information ≠ Apple ID

App Store Connect → Test Information / App Review asks for **Sign-in information**.
That is a **demo account inside pqp** (Clerk email + password) so Apple’s
reviewers can open the app. It is **not**:

- your Apple Developer login
- Sign in with Apple (which pqp does offer, and does need: see below)

### Create the demo account (Rafael)

1. Clerk Dashboard → Users → create user with **email + password** (OTP-only will
   block reviewers).
2. Suggested email: something like `appstore-review@<inbox you control>`.
3. Sign in once on **production** (web or TestFlight), complete the **18+ age
   gate** with an adult date of birth.
4. Join or create a small private community with a few messages and a second
   dummy user (so Report / Block are exercisable).
5. Paste email + password into ASC → TestFlight → **Test Information** → Sign-in
   information.
6. Notes template (paste and edit):

```
18+ age gate already completed on this account.
After sign-in you land in the seeded community.
UGC: long-press / message menu → Report; profile → Block.
Privacy: https://pqp.gg/privacy
Terms: https://pqp.gg/terms
Contact: <your abuse email>
```

## External TestFlight (public / invite link)

1. Confirm distribution profiles (`pqp appstore`, `pqp broadcast appstore`) are valid.
2. Archive Release in Xcode → upload to App Store Connect.
3. Internal testing first — smoke the demo account on a device.
4. Fill Test Information (above).
5. External group → add build → **Beta App Review**.
6. When Apple approves, copy the public link:
   `https://testflight.apple.com/join/XXXXXXXX`
7. Set it for the website:

```bash
# GitHub Actions → Pages build
gh secret set VITE_TESTFLIGHT_URL --body 'https://testflight.apple.com/join/XXXXXXXX'

# Local client/.env (optional)
VITE_TESTFLIGHT_URL=https://testflight.apple.com/join/XXXXXXXX
```

Redeploy the web app (`Deploy Web` after CI on `main`, or `workflow_dispatch`).

## Sign in with Apple

**Settled: it is required, and it is offered.** The question this section used to
leave open is answered by the live Clerk instance. `clerk.pqp.gg` has both
`oauth_google` and `oauth_apple` enabled and authenticatable, which you can read
back at any time:

```bash
curl -s 'https://clerk.pqp.gg/v1/environment?__clerk_api_version=2021-02-05&_clerk_js_version=5.0.0' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["user_settings"]["social"])'
```

Google being enabled is what makes Sign in with Apple mandatory under Guideline
4.8. Apple being enabled is what satisfies it: the app's sign-in sheet is Clerk's
`AuthView`, which renders one button per enabled provider, so both appear with no
code of ours involved.

**Build 12 and earlier shipped that button broken.** Clerk's iOS SDK takes the
native path for Apple (`ASAuthorizationAppleIDProvider`), and the app carried no
`com.apple.developer.applesignin` entitlement, so the request fails. Google was
fine, because it goes through `ASWebAuthenticationSession`, which needs no
entitlement. The entitlement is now declared in `ios/project.yml`.

Before the next archive, on the developer portal:

1. App ID `gg.pqp.app` → enable the **Sign in with Apple** capability.
2. Re-mint the **`pqp appstore`** provisioning profile so it carries it.
3. Otherwise Release signing fails with "provisioning profile doesn't include the
   com.apple.developer.applesignin entitlement". Debug and simulator builds do
   not sign and are unaffected.
4. Then tap **Continue with Apple** on a device once. That is the only way to
   know it works.

A review account with **email + password** (below) keeps a reviewer off the
social path entirely, which is why this was never caught. That is luck, not a
mitigation: reviewers do test Sign in with Apple.

## Related

- `docs/IOS.md` — run the app, APNs, universal links
- `docs/superpowers/specs/2026-08-20-vs-discord-and-testflight-design.md` — product claims + path
- Marketing: `/vs-discord`, footer “Join the iOS beta”
