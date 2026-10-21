# Changelog

All notable changes to `@pqp/app-sdk`. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), the versions follow [SemVer](https://semver.org/).

## Versioning policy

An app declares two numbers that concern this package, and they are different things.

- **`platformApi` in the app's manifest** is the version of the message API between the app and the pqp page. This package speaks exactly one, written in `package.json` as `pqp.platformApi` and visible with `npm view @pqp/app-sdk pqp`. Only `1` exists.
- **The SDK version** is the shape of the JavaScript you import.

The rules:

- A change to the **wire protocol** (a new `platformApi`) is a **new major version** of this package. Platform API 2 would ship as `@pqp/app-sdk@2.x`, and `1.x` stays the SDK for apps whose manifest says `platformApi: 1` for as long as pqp serves platform API 1.
- A **backwards-compatible addition** (a new method, a new option, a new exported type) is a **minor** version. An older SDK keeps working against a newer pqp page, because the page's messages to an app tolerate fields it does not know (they are dropped, never rejected). The other direction is strict: the page refuses a request with a field it does not know, so a call that needs new host support waits for a platform API bump.
- A **fix** that does not change a signature is a **patch**.
- **Before 1.0.0** the API is not frozen: a minor version (`0.2.0`) may break a signature. Pin the exact version while you are on `0.x`.
- A new release of this package changes the bytes of every app built with it. For an app already published to the catalog that means a new app `version` (pqp refuses two different builds of one version). That is a property of the catalog, not a reason to hold back an SDK release.

## [0.1.0] - unreleased

First version prepared for npm. Nothing has been published yet; the package is still `"private": true` in the repository until its first release is cut (see `PUBLISHING.md`).

### Added

- `connect()`, the app object (`participants`, `state`, `events`, `assets`, `files`, `ui`, `share`, `end`, `on`), `applyTheme()`, `PqpAppError`, and the lower-level `createApp()` and `PortClient`.
- A build to `dist/` (ES2022 modules and `.d.ts`), a staging step that writes the publishable `package.json`, and a check that the tarball is self-contained.
- The wire types (`JsonValue`, `BridgeHello`, `BridgeParticipant`, `BridgeErrorCode`, `BridgeTheme`, `AppEndReason`, `AppRole`, `AppParticipantConnection`, `BridgeConnectionStatus`) are exported from the package.

- `app.on("share", (on) => ...)`: whether the pane is shared, whoever turned it on or off (the app, pqp's switch above the pane, the call's own stop), so an app's share control always says what pqp's says. Rides the `share` push; an older page never sends it.

### Changed

- The wire types are written out in the package instead of imported from `@pqp/shared`, so the published `.d.ts` needs nothing else installed. A test fails if either copy drifts from the other. The runtime code is unchanged: the bundle of every first-party app is byte for byte what it was.
