package gg.pqp.app.bau

import gg.pqp.app.core.ApiClient
import gg.pqp.app.core.Backend
import gg.pqp.app.social.getJson
import java.util.WeakHashMap
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.Serializable

/*
 * A Baú post pasted into chat, drawn as a card.
 *
 * The Kotlin half of `packages/shared/src/community-home-share.ts` and
 * `client/src/lib/community-home/share-card.ts`. Everything here is pure (no
 * Compose, no `android.net.Uri`, which is a stub on the JVM), so the rules are
 * pinned by `BauShareTest` rather than by a screenshot.
 *
 * Authorization is the server's: `GET …/home/posts/:id/card` answers 404 to a
 * viewer who may not see the post, and the caller then keeps showing the plain
 * link. Nothing in this file decides who may see a post, only when to ask.
 */

/** The post an address names. Ids are lower-cased so a shouted link matches the row. */
data class BauPostRef(val serverId: String, val postId: String)

/** A permalink found in text. [start] and [end] index the scanned text, [end] exclusive. */
data class BauPostLink(
    val ref: BauPostRef,
    /** The URL exactly as it appears in the text. */
    val url: String,
    /** Its origin, e.g. `https://pqp.gg`. */
    val origin: String,
    val start: Int,
    val end: Int,
) {
    val serverId: String get() = ref.serverId
    val postId: String get() = ref.postId
}

/** Which link in a message gets a card, and whether the card can replace the whole message. */
data class BauCardSelection(val link: BauPostLink, val linkOnly: Boolean)

object BauShare {

    private const val UUID =
        "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"

    private val PATH_RE = Regex("^/app/server/($UUID)/bau/($UUID)/?$")
    private val URL_RE = Regex("""https?://[^\s<>()\[\]]+""", RegexOption.IGNORE_CASE)
    private val TRAILING_PUNCTUATION_RE = Regex("""[.,;:!?'"]+$""")
    private val URL_PARTS_RE = Regex("""^(https?)://([^/?#]*)([^?#]*)""", RegexOption.IGNORE_CASE)

    /** Hosts that always mean this product, on top of the origin the app is built against. */
    private val HOSTED_APP_HOSTS = setOf("pqp.gg", "www.pqp.gg")

    /** Where a post lives inside the app. Always relative; callers add an origin. */
    fun path(serverId: String, postId: String): String = "/app/server/$serverId/bau/$postId"

    /** The post a `/app/server/<id>/bau/<id>` path names, or null. */
    fun parsePath(pathname: String): BauPostRef? {
        val match = PATH_RE.matchEntire(pathname) ?: return null
        return BauPostRef(match.groupValues[1].lowercase(), match.groupValues[2].lowercase())
    }

    /**
     * `scheme://host[:port]`, lower-cased, with a default port dropped, which
     * is what `URL.origin` answers in the browser. Null when [authority] has no host.
     */
    private fun originOf(scheme: String, authority: String): String? {
        // Anything before the last `@` is credentials, never the host.
        val hostPort = authority.substringAfterLast('@').lowercase()
        if (hostPort.isEmpty() || hostPort.startsWith(":")) return null
        val s = scheme.lowercase()
        val port = hostPort.substringAfterLast(':', "")
        val host = if (port.isNotEmpty() && port.all { it.isDigit() }) hostPort.dropLast(port.length + 1) else hostPort
        if (host.isEmpty()) return null
        val defaultPort = if (s == "https") "443" else "80"
        val keepPort = port.isNotEmpty() && port.all { it.isDigit() } && port != defaultPort
        return if (keepPort) "$s://$host:$port" else "$s://$host"
    }

    /**
     * Every Baú post permalink in a message body, in order. Origin policy is
     * the caller's: this only says that the path is a Baú post. Query strings
     * and fragments are allowed and ignored, a trailing sentence mark is not
     * part of the link.
     */
    fun findLinks(text: String): List<BauPostLink> {
        val found = ArrayList<BauPostLink>()
        for (match in URL_RE.findAll(text)) {
            val raw = match.value.replace(TRAILING_PUNCTUATION_RE, "")
            val parts = URL_PARTS_RE.find(raw) ?: continue
            val origin = originOf(parts.groupValues[1], parts.groupValues[2]) ?: continue
            val ref = parsePath(parts.groupValues[3]) ?: continue
            val start = match.range.first
            found += BauPostLink(ref, raw, origin, start, start + raw.length)
        }
        return found
    }

    /** The bare URL a person tapped, if it is a Baú post address on this instance. */
    fun refOfUrl(url: String, appOrigin: String? = ownOrigin()): BauPostRef? {
        val link = findLinks(url).singleOrNull { it.start == 0 && it.end == url.length } ?: return null
        return if (isOwnInstanceOrigin(link.origin, appOrigin)) link.ref else null
    }

    /** Whether a message body is nothing but the link, so the card can stand alone. */
    fun bodyIsOnlyLink(text: String, link: BauPostLink): Boolean =
        text.substring(0, link.start).isBlank() &&
            text.substring(link.end).trim().replace(TRAILING_PUNCTUATION_RE, "").isEmpty()

    /**
     * Is [origin] this instance? The origin the app is built against, or the
     * hosted app over https. A link to somebody else's pqp would need their API
     * and their session, so it stays plain text and the server never sees a
     * foreign id.
     */
    fun isOwnInstanceOrigin(origin: String, appOrigin: String?): Boolean {
        if (appOrigin != null && origin == appOrigin) return true
        val parts = URL_PARTS_RE.find(origin) ?: return false
        return parts.groupValues[1].equals("https", ignoreCase = true) &&
            parts.groupValues[2].lowercase() in HOSTED_APP_HOSTS
    }

    /** The app's configured web origin, normalised the way a link's origin is. */
    fun ownOrigin(appUrl: String = Backend.appUrl): String? {
        val parts = URL_PARTS_RE.find(appUrl) ?: return null
        return originOf(parts.groupValues[1], parts.groupValues[2])
    }

    /** The first same-instance Baú permalink in a message body, or null. */
    fun select(body: String?, appOrigin: String? = ownOrigin()): BauCardSelection? {
        if (body.isNullOrEmpty()) return null
        for (link in findLinks(body)) {
            if (isOwnInstanceOrigin(link.origin, appOrigin)) {
                return BauCardSelection(link, bodyIsOnlyLink(body, link))
            }
        }
        return null
    }

    /**
     * The message with the card's own link taken out, so the words the sender
     * wrote stay and the long URL does not sit above its own card. Blank lines
     * the removal leaves behind are collapsed.
     */
    fun stripLink(body: String, link: BauPostLink): String =
        (body.substring(0, link.start) + body.substring(link.end))
            .replace(Regex("""[ \t]+\n"""), "\n")
            .replace(Regex("""\n{3,}"""), "\n\n")
            .trim()
}

// ---------------------------------------------------------------- wire

@Serializable
data class BauCardAuthor(
    val id: String = "",
    val displayName: String = "",
    val avatarUrl: String? = null,
)

/**
 * `GET /api/servers/:serverId/home/posts/:postId/card` -> `{ card }`
 * (`communityHomePostCardSchema`). `mediaUrl` is an image URL (image, YouTube
 * poster) or a signed video file URL, and null for a text post, a locked
 * upload and an embed with no poster.
 */
@Serializable
data class BauPostCard(
    val postId: String,
    val serverId: String,
    val serverName: String = "",
    val title: String? = null,
    val teaser: String? = null,
    /** Null on a locked post: who wrote a members-only post is withheld. */
    val author: BauCardAuthor? = null,
    /** `image` / `video` / `youtube` / `twitch` / `tiktok` / `instagram` / `file`, or null. */
    val mediaKind: String? = null,
    val mediaUrl: String? = null,
    val visibility: String = "public",
    val locked: Boolean = false,
    val pinned: Boolean = false,
    val likeCount: Int = 0,
    val commentCount: Int = 0,
    val publishedAt: String? = null,
) {
    /** What fills the poster slot. See [BauCardPoster]. */
    val poster: BauCardPoster get() = BauCardPoster.of(this)

    /** A play badge is drawn for anything that plays, unless the post is locked. */
    val showsPlayBadge: Boolean
        get() = !locked && mediaKind in PLAYABLE && poster != BauCardPoster.None

    companion object {
        val PLAYABLE = setOf("video", "youtube", "twitch", "tiktok", "instagram")
    }
}

@Serializable
data class BauCardResponse(val card: BauPostCard)

/** The poster slot, decided without Compose. Mirrors `posterKind` in `bau-post-card.tsx`. */
enum class BauCardPoster {
    /** A picture to load. */
    Image,

    /** A signed video file: its first frame, never played here. */
    VideoFrame,

    /** Twitch, TikTok, Instagram: nothing we may fetch, but the plate says "video". */
    Plate,

    /** Text only: a short lime-tinted strip instead of a 16:9 poster. */
    None;

    companion object {
        fun of(card: BauPostCard): BauCardPoster = when {
            card.mediaKind == "video" && card.mediaUrl != null -> VideoFrame
            card.mediaUrl != null && (card.mediaKind == "image" || card.mediaKind == "youtube") -> Image
            card.mediaKind != null && card.mediaKind in BauPostCard.PLAYABLE -> Plate
            else -> None
        }
    }
}

suspend fun ApiClient.bauPostCard(serverId: String, postId: String, lang: String?): BauPostCard =
    getJson<BauCardResponse>(
        "/api/servers/$serverId/home/posts/$postId/card",
        if (lang.isNullOrBlank()) emptyMap() else mapOf("lang" to lang),
    ).card

// ---------------------------------------------------------------- loading

/**
 * Card fetches, remembered. Long enough to scroll a channel back and forth,
 * short enough for a like count; a refusal is remembered too, or every
 * recomposition of a row whose card is a 404 would be a new request.
 *
 * The fetch runs in [scope], not in the caller: a row that scrolls away
 * cancels its own collector, and that must not cancel the answer the next
 * row for the same post is waiting on.
 */
class BauCardCache(
    private val scope: CoroutineScope,
    private val fetch: suspend (serverId: String, postId: String, lang: String?) -> BauPostCard?,
    private val now: () -> Long = System::currentTimeMillis,
    private val okTtlMs: Long = OK_TTL_MS,
    private val missTtlMs: Long = MISS_TTL_MS,
    private val maxEntries: Int = MAX_ENTRIES,
) {
    private class Entry {
        lateinit var result: Deferred<BauPostCard?>

        /** Null while the request is in flight. */
        @Volatile var doneAt: Long? = null
        @Volatile var value: BauPostCard? = null
    }

    private val entries = LinkedHashMap<String, Entry>()

    /** The card, or null when the viewer may not see it (or the network said no). */
    suspend fun load(serverId: String, postId: String, lang: String?): BauPostCard? {
        val key = "$serverId:$postId:${lang.orEmpty()}"
        val entry = synchronized(entries) {
            val hit = entries[key]
            val doneAt = hit?.doneAt
            val usable = hit != null &&
                (doneAt == null || now() - doneAt < (if (hit.value == null) missTtlMs else okTtlMs))
            if (usable) {
                hit!!
            } else {
                entries.remove(key)
                if (entries.size >= maxEntries) {
                    entries.keys.firstOrNull()?.let { entries.remove(it) }
                }
                val fresh = Entry()
                fresh.result = scope.async {
                    val value = try {
                        fetch(serverId, postId, lang)
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (_: Exception) {
                        // 4xx: not ours to show. Offline or 5xx: a plain link for
                        // now, and the short miss TTL lets the next render try again.
                        null
                    }
                    fresh.value = value
                    fresh.doneAt = now()
                    value
                }
                entries[key] = fresh
                fresh
            }
        }
        return entry.result.await()
    }

    companion object {
        const val OK_TTL_MS = 60_000L
        const val MISS_TTL_MS = 30_000L
        const val MAX_ENTRIES = 200
    }
}

/** One cache per signed-in client, so a card never outlives the account that was allowed to see it. */
object BauCards {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val caches = WeakHashMap<ApiClient, BauCardCache>()

    fun of(api: ApiClient): BauCardCache = synchronized(caches) {
        caches.getOrPut(api) {
            BauCardCache(scope, { serverId, postId, lang -> api.bauPostCard(serverId, postId, lang) })
        }
    }
}
