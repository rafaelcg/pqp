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
     * Clerk when a key is present, otherwise the dev bypass.
     *
     * Stated this way round on purpose: a release build with no key should be
     * loudly unable to authenticate rather than quietly falling back to a token
     * that only a local server accepts. Same rule as `AppConfig.authMode` on
     * iOS.
     */
    val authMode: AuthMode =
        if (clerkPublishableKey == null) AuthMode.DevBypass else AuthMode.Clerk

    /**
     * Several fields on the wire are root-relative (`/api/avatars/…`,
     * `/api/servers/:id/icon`). Attachment URLs are presigned absolutes. One
     * helper so no call site has to know which it is holding.
     */
    fun absolute(url: String?): String? = when {
        url.isNullOrBlank() -> null
        url.startsWith("http://") || url.startsWith("https://") -> url
        url.startsWith("/") -> apiUrl + url
        else -> "$apiUrl/$url"
    }
}

enum class AuthMode { Clerk, DevBypass }
