package gg.pqp.app.bau

import android.content.Context
import android.content.Intent

/**
 * Compartilhar on a public Baú post: the Android half of
 * `client/src/lib/community-home/public-share.ts`.
 *
 * The link is the post's `publicUrl`, exactly as the API sent it. The phone
 * never builds a public address itself: only the API knows whether the post
 * qualifies (published, free, a community with a public address, the flag on),
 * and it says so by sending the field at all.
 */
object BauPublicShare {

    /** What the acquisition capture on the landing reads (`bauShareUrl` in shared). */
    const val UTM_SOURCE = "native"
    const val UTM_MEDIUM = "share"
    const val UTM_CAMPAIGN = "bau"

    /**
     * The URL to hand the share sheet, or null when the post has no public
     * page or is not something a member should be offered to share: locked
     * for this viewer, or not published.
     */
    fun shareableUrl(post: BauPost): String? {
        val url = post.publicUrl?.trim()
        if (url.isNullOrEmpty()) return null
        if (post.locked || post.status != "published") return null
        return url
    }

    /**
     * [publicUrl] with `utm_source=native&utm_medium=share&utm_campaign=bau`.
     *
     * Every `utm_*` already on the link is dropped first, so a link that went
     * round once is credited to this share and never carries two campaigns.
     * Other parameters and a fragment are kept as they were, byte for byte.
     * Plain string work rather than `android.net.Uri`, so it runs in a JVM test.
     */
    fun withCampaign(publicUrl: String): String {
        val trimmed = publicUrl.trim()
        val hashAt = trimmed.indexOf('#')
        val beforeHash = if (hashAt >= 0) trimmed.substring(0, hashAt) else trimmed
        val fragment = if (hashAt >= 0) trimmed.substring(hashAt) else ""
        val queryAt = beforeHash.indexOf('?')
        val base = if (queryAt >= 0) beforeHash.substring(0, queryAt) else beforeHash
        val kept = if (queryAt >= 0) {
            beforeHash.substring(queryAt + 1)
                .split('&')
                .filter { it.isNotEmpty() && !isUtm(it) }
        } else {
            emptyList()
        }
        val campaign = listOf(
            "utm_source=$UTM_SOURCE",
            "utm_medium=$UTM_MEDIUM",
            "utm_campaign=$UTM_CAMPAIGN",
        )
        return base + "?" + (kept + campaign).joinToString("&") + fragment
    }

    private fun isUtm(pair: String): Boolean =
        pair.substringBefore('=').lowercase().startsWith("utm_")

    /**
     * The system share sheet for [publicUrl]. [title] rides as subject and as
     * the sheet's preview title when there is one; where the link goes is the
     * phone's business. False when nothing could take the intent.
     */
    fun share(context: Context, publicUrl: String, title: String?, chooserTitle: String): Boolean {
        val heading = title?.trim()?.takeIf { it.isNotEmpty() }
        val send = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, withCampaign(publicUrl))
            if (heading != null) {
                putExtra(Intent.EXTRA_SUBJECT, heading)
                putExtra(Intent.EXTRA_TITLE, heading)
            }
        }
        return runCatching { context.startActivity(Intent.createChooser(send, chooserTitle)) }.isSuccess
    }
}
