package gg.pqp.app.core

import gg.pqp.app.BuildConfig

/**
 * Where the app talks to, and how it proves who it is.
 *
 * Both URLs are build inputs (see `app/build.gradle.kts`) rather than
 * constants, because the emulator, a phone on the same wifi and the hosted API
 * are three different addresses and only one of them can be a default.
 */
object Backend {
    val apiUrl: String = BuildConfig.API_URL.trimEnd('/')
    val wsUrl: String = BuildConfig.WS_URL

    val clerkPublishableKey: String? =
        BuildConfig.CLERK_PUBLISHABLE_KEY.takeIf { it.isNotBlank() }

    /**
     * Clerk when a key is present. Otherwise the dev bypass in a debug build,
     * and a build that admits it is broken in a release one.
     *
     * The comment here used to promise exactly that, and the code did the
     * opposite: with no key it answered `DevBypass` in **every** variant, so a
     * signed release aimed at `https://api.pqp.gg` offered "Continue as a local
     * dev account" as the only button on its sign-in screen. That token is
     * refused by any server not running `DEV_AUTH_BYPASS`, and the bypass is
     * ignored outright when `NODE_ENV=production`, so it could never have
     * worked. A tester would install the build, press the only thing on screen
     * and be unable to sign in at all.
     *
     * `BuildConfig.DEBUG` is what separates the two now, rather than the key
     * alone. The key still selects Clerk; the variant decides whether falling
     * back is allowed to happen.
     */
    val authMode: AuthMode = when {
        clerkPublishableKey != null -> AuthMode.Clerk
        BuildConfig.DEBUG -> AuthMode.DevBypass
        else -> AuthMode.Misconfigured
    }

    /**
     * Several fields on the wire are root-relative (`/api/avatars/…`,
     * `/api/servers/:id/icon`). Attachment URLs are presigned absolutes. One
     * helper so no call site has to know which it is holding.
     *
     * `content://` and `file://` are passed through untouched for the same
     * reason: an optimistic message drawn the instant its attachment is sent
     * points at the file still sitting on the phone, because the presigned GET
     * does not exist until the broadcast comes back. Prefixing those with the
     * API's host produced `http://host/content://…`, which is a broken image in
     * the sender's own bubble for as long as the round trip takes.
     */
    fun absolute(url: String?): String? = when {
        url.isNullOrBlank() -> null
        url.startsWith("http://") || url.startsWith("https://") -> url
        url.startsWith("content://") || url.startsWith("file://") -> url
        url.startsWith("/") -> apiUrl + url
        else -> "$apiUrl/$url"
    }
}

enum class AuthMode {
    Clerk,
    DevBypass,

    /**
     * A release build with no Clerk publishable key compiled into it. There is
     * no way to sign in and pretending otherwise wastes a tester's time, so the
     * screen says so instead of offering a button that cannot work.
     *
     * Reaching this in a build somebody is holding is a packaging mistake, not
     * a runtime one: pass `pqp.clerkPublishableKey` (a `-P` flag,
     * `local.properties` or `PQP_CLERKPUBLISHABLEKEY`) when building the
     * bundle. See docs/ANDROID_RELEASE.md.
     */
    Misconfigured,
}
