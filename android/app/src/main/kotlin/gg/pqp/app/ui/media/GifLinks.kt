package gg.pqp.app.ui.media

import java.net.URI

/**
 * A message body that is nothing but a GIF URL.
 *
 * GIFs reach a channel by two routes and only one of them is an attachment.
 * The picker calls `POST /api/channels/:id/attachments/gif`, which stores a row
 * with a remote URL, so those arrive in `message.attachments` and render there.
 * A **pasted** link does not: it is stored as the message body and nothing
 * else, and `packages/shared/src/gifs.ts` is where both other clients agree
 * that such a body renders as media rather than as text. The web client does
 * exactly this in `client/src/lib/gif-media.ts`.
 *
 * Without this, a pasted Tenor link that animates on the web reads on Android
 * as a hundred characters of URL, which is the same feature broken a second
 * way.
 *
 * The allowlist is the point, and it is a security boundary rather than a
 * convenience: a body is rendered as a picture from a host we did not upload
 * to, so anything outside these four hosts stays a piece of text. It is copied
 * from shared by hand, like every other wire fact in this module, and
 * `GifLinksContractTest` reads `packages/shared/src/gifs.ts` off disk and fails
 * the build when the two drift.
 */
object GifLinks {

    /**
     * Hosts whose URLs may be drawn as an image.
     *
     * Anchored at both ends, exactly as the shared regexes are. `giphy.com`
     * itself is deliberately absent: only the media subdomains serve bytes,
     * and the bare domain serves pages.
     */
    private val MEDIA_HOSTS = listOf(
        Regex("""^media\d*\.giphy\.com$"""),
        Regex("""^i\.giphy\.com$"""),
        Regex("""^media\d*\.tenor\.com$"""),
        Regex("""^c\.tenor\.com$"""),
    )

    private val MEDIA_EXTENSIONS = listOf(".gif", ".webp", ".png", ".jpg", ".jpeg")

    /**
     * True when a URL may be drawn as an image rather than shown as a link.
     *
     * `URI` and not `Uri`: this has to be callable from a JVM unit test, and
     * `android.net.Uri` is one of the stubs that throws on the unit-test
     * classpath. It is also the stricter parser, which is what is wanted for a
     * check whose whole job is to refuse.
     */
    fun isMediaUrl(value: String): Boolean = parse(value) != null

    /**
     * Read a body as inline media, or null when it is ordinary text.
     *
     * A body qualifies only when it is *nothing but* an allowlisted URL. Any
     * surrounding words mean somebody wrote a sentence that contains a link,
     * and swallowing the sentence to show the picture would lose what they
     * said. Same rule as `gifMessageMedia` on the web, for the same reason.
     */
    fun mediaBody(body: String): String? {
        val trimmed = body.trim()
        if (trimmed.isEmpty() || trimmed.any { it.isWhitespace() }) return null
        return if (isMediaUrl(trimmed)) trimmed else null
    }

    private fun parse(value: String): URI? {
        val uri = runCatching { URI(value) }.getOrNull() ?: return null

        // https only, and no embedded credentials. Both are copied from
        // shared: http would be a mixed-content block in a browser, and
        // `https://media.giphy.com@evil.example/a.gif` is the classic way to
        // make a hostile host read as a trusted one to somebody skimming.
        if (!uri.scheme.equals("https", ignoreCase = true)) return null
        if (uri.userInfo != null) return null

        val host = uri.host?.lowercase() ?: return null
        if (MEDIA_HOSTS.none { it.matches(host) }) return null

        val path = uri.path?.lowercase() ?: return null
        if (MEDIA_EXTENSIONS.none { path.endsWith(it) }) return null

        return uri
    }
}
