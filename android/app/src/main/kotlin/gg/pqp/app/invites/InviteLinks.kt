package gg.pqp.app.invites

import gg.pqp.app.core.Backend
import gg.pqp.app.core.Invite

/**
 * The link a person actually sends, and the two facts worth saying about it.
 *
 * Pure so the shape can be pinned by a JVM test: the URL this builds is the
 * one `client/src/components/layout/invite-panel.tsx` builds (`inviteLink`),
 * the one the manifest's App Links filter claims, and the one
 * `gg.pqp.app.push.DeepLink` parses back. Three places agree on one string, and
 * a change to any of them should fail a test here rather than a friend's tap.
 */
object InviteLinks {

    /**
     * `https://pqp.gg/app/invite/<code>`.
     *
     * The web's `encodeURIComponent` is a no-op on the codes the server mints
     * (`generateInviteCode` in `server/src/services/invites.ts` is
     * alphanumeric), so the code is put in as it is and a code that would need
     * escaping is treated as not a code at all, the same call `DeepLink` makes
     * on the way in.
     */
    fun link(code: String, appUrl: String = Backend.appUrl): String? {
        if (!isUsableCode(code)) return null
        return appUrl.trimEnd('/') + "/app/invite/" + code
    }

    fun link(invite: Invite): String? = link(invite.code)

    /** The same rule as `DeepLink.isUsableCode`, kept in step by test. */
    fun isUsableCode(code: String): Boolean =
        code.length in 1..64 && code.all { it.isLetterOrDigit() || it == '-' || it == '_' }

    /**
     * Whether the server would still honour this invite, judged from what it
     * said when it listed it. The server is the authority and refuses in its
     * own words; this only decides whether a row is worth offering to share.
     */
    fun isLive(invite: Invite, nowMillis: Long): Boolean {
        val exhausted = invite.maxUses != null && invite.uses >= invite.maxUses
        if (exhausted) return false
        val expiresAt = invite.expiresAt?.let { parseIsoMillis(it) } ?: return true
        return expiresAt > nowMillis
    }

    /**
     * Whole hours left on an invite, or null when it never expires. Zero for
     * "less than an hour", negative never: an expired invite is not live and
     * is not shown.
     */
    fun hoursLeft(invite: Invite, nowMillis: Long): Long? {
        val expiresAt = invite.expiresAt?.let { parseIsoMillis(it) } ?: return null
        return ((expiresAt - nowMillis).coerceAtLeast(0L)) / HOUR_MILLIS
    }

    /**
     * `java.time` rather than `android.text.format`, because this runs in
     * plain JVM unit tests. The server emits `toISOString()`, which is always
     * UTC with a `Z`, and that is the only shape accepted.
     */
    private fun parseIsoMillis(value: String): Long? =
        runCatching { java.time.Instant.parse(value).toEpochMilli() }.getOrNull()

    private const val HOUR_MILLIS = 60L * 60L * 1000L
}
