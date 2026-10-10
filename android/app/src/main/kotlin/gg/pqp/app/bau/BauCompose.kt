package gg.pqp.app.bau

import gg.pqp.app.attachments.attachmentContentTypeFor
import gg.pqp.app.core.ApiException
import gg.pqp.app.core.Channel
import gg.pqp.app.core.Permission
import gg.pqp.app.core.PermissionsSnapshot
import gg.pqp.app.core.hasPermission
import gg.pqp.app.core.parsePermissionBits
import java.net.URI
import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.Serializable

/*
 * Writing a post, the rules the server applies, said once.
 *
 * Every number here is a hand-copy of `packages/shared/src/community-home.ts`
 * (`BauComposeContractTest` reads that file off disk to keep them honest), and
 * every check is one the server repeats. The phone checks first only so a
 * refusal arrives before a 40 MB upload rather than after it; the server stays
 * the authority, which is also why nothing here decides who may post.
 */

const val BAU_TITLE_MAX = 200
const val BAU_BODY_MAX = 4000

/** `COMMUNITY_HOME_MAX_BYTES`. 100 MiB, per file. */
const val BAU_MAX_BYTES: Long = 100L * 1024 * 1024

/**
 * What the Photo Picker may hand back. The shared allowlist also carries
 * `application/pdf`, which is not a photo or a video and has no place behind a
 * photo picker; a PDF is still welcome from the web.
 */
val BAU_PICKER_MIME_TYPES: List<String> = listOf(
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
    "video/mp4",
    "video/webm",
)

/** `contentType` is signed into the presigned PUT, so it has to be one of these exactly. */
fun bauMediaType(reported: String?, filename: String): String? =
    attachmentContentTypeFor(reported, filename)?.takeIf { it in BAU_PICKER_MIME_TYPES }

// --- who may post -----------------------------------------------------------

/**
 * The compose button, offered or not.
 *
 * Not a guess about roles. The server publishes for `MANAGE_SERVER` and
 * nobody else, and the permissions route answers that question already
 * resolved (owner and administrator folded in, roles and timeouts too), so
 * this asks the same bit of the same snapshot the web asks. FAILS CLOSED: a
 * snapshot that never arrived is "no", because a button shown to somebody the
 * server will refuse is a worse mistake than one that shows up a second late.
 * It also needs the instance flag, since every `/home` route 404s without it.
 */
object BauComposeGate {

    fun canPost(config: CommunityHomeConfig, permissions: PermissionsSnapshot?): Boolean =
        config.enabled && permissions != null &&
            hasPermission(parsePermissionBits(permissions.server), Permission.MANAGE_SERVER)

    /** Photos and videos need object storage; a link and text do not. */
    fun canAttachFiles(config: CommunityHomeConfig): Boolean = config.mediaEnabled
}

// --- wire -------------------------------------------------------------------

/**
 * `POST /api/servers/:id/home/posts`. `status = published` is the whole point:
 * the server's default is `draft`, which the phone has no screen for.
 *
 * `encodeDefaults = false` on [gg.pqp.app.core.PqpJson] would drop a field
 * that equals its Kotlin default, and "published" is exactly such a field: the
 * request would go out without it and the server would save a draft that
 * never appears in the feed. So the three fields whose server default differs
 * from, or merely must not depend on, ours are `@EncodeDefault`. The media
 * fields stay off the wire when unset, which the server reads as "no media".
 */
@OptIn(ExperimentalSerializationApi::class)
@Serializable
data class CreateBauPostRequest(
    val title: String,
    val body: String? = null,
    val mediaUploadId: String? = null,
    val youtubeUrl: String? = null,
    @EncodeDefault val status: String = "published",
    @EncodeDefault val visibility: String = "free",
    @EncodeDefault val commentsEnabled: Boolean = true,
)

@Serializable
data class CreateBauPostResponse(val post: BauPost)

/** `POST …/home/media`. */
@Serializable
data class MintBauMediaRequest(
    val contentType: String,
    val byteSize: Long,
    val filename: String,
)

@Serializable
data class MintBauMediaResponse(
    val uploadId: String,
    val uploadUrl: String,
    val kind: String = "image",
)

/** `POST …/home/media/claim`. */
@Serializable
data class ClaimBauMediaRequest(val uploadId: String)

@Serializable
data class ClaimBauMediaResponse(
    val uploadId: String,
    val kind: String = "image",
    val name: String = "",
)

// --- the draft ----------------------------------------------------------------

/** One file picked and (when [uploadId] is set) already sitting in storage. */
data class BauPickedMedia(
    val filename: String,
    val contentType: String,
    val byteSize: Long,
    val isVideo: Boolean,
    val uploadId: String? = null,
    val uploading: Boolean = false,
    val failed: Boolean = false,
)

enum class BauComposeProblem {
    /** The server needs a title to publish. */
    NeedsTitle,

    /** Title and body fit, but there is nothing to show: no body, no file, no link. */
    NeedsContent,
    TitleTooLong,
    BodyTooLong,

    /** A file and a link together: the server takes one media source. */
    OneMediaSource,
    BadLink,
    FileStillUploading,
    FileFailed,
}

data class BauComposeDraft(
    val title: String = "",
    val body: String = "",
    val link: String = "",
    val media: BauPickedMedia? = null,
) {
    val trimmedTitle: String get() = title.trim()
    val trimmedBody: String get() = body.trim()
    val trimmedLink: String get() = link.trim()

    /**
     * First thing wrong with this draft, or null when it can go. The body's
     * limit is checked on what the server will store: a `#channel` is
     * `<#uuid>` there, forty characters for a handful.
     */
    fun problem(channels: List<Channel> = emptyList()): BauComposeProblem? = when {
        trimmedTitle.isEmpty() -> BauComposeProblem.NeedsTitle
        title.length > BAU_TITLE_MAX -> BauComposeProblem.TitleTooLong
        BauChannelRefs.toStored(body, channels).length > BAU_BODY_MAX -> BauComposeProblem.BodyTooLong
        media != null && trimmedLink.isNotEmpty() -> BauComposeProblem.OneMediaSource
        trimmedLink.isNotEmpty() && BauLinks.provider(trimmedLink) == null -> BauComposeProblem.BadLink
        media?.uploading == true -> BauComposeProblem.FileStillUploading
        media?.failed == true -> BauComposeProblem.FileFailed
        trimmedBody.isEmpty() && media == null && trimmedLink.isEmpty() -> BauComposeProblem.NeedsContent
        else -> null
    }

    /**
     * The request, or null while [problem] says no. The media id and the link
     * are mutually exclusive by construction, which is the server's own
     * "pick one media source" rule.
     */
    fun toRequest(channels: List<Channel> = emptyList()): CreateBauPostRequest? {
        if (problem(channels) != null) return null
        return CreateBauPostRequest(
            title = trimmedTitle,
            // `#name` typed or picked becomes `<#id>`, so a rename never breaks it.
            body = BauChannelRefs.toStored(trimmedBody, channels).ifEmpty { null },
            mediaUploadId = media?.uploadId,
            youtubeUrl = trimmedLink.ifEmpty { null },
        )
    }
}

// --- links ------------------------------------------------------------------

/**
 * Which of the four embed providers a pasted link looks like, by host alone.
 *
 * Deliberately NOT a port of the shared parsers: those decide which paths are
 * a post and which are a profile, and a second copy that drifted would tell a
 * person "looks good" about a link the server then refuses. This only names
 * the provider for the preview chip and catches what is plainly not a link;
 * the server's answer (a 400 with its own sentence) stays the verdict, and the
 * composer shows it.
 */
object BauLinks {

    enum class Provider { Youtube, Twitch, TikTok, Instagram }

    fun provider(raw: String): Provider? {
        val trimmed = raw.trim()
        if (trimmed.isEmpty() || trimmed.any { it.isWhitespace() }) return null
        val uri = runCatching { URI(trimmed) }.getOrNull() ?: return null
        if (uri.scheme?.lowercase() !in setOf("http", "https")) return null
        val host = uri.host?.lowercase()?.removePrefix("www.") ?: return null
        return when {
            host == "youtu.be" || host == "youtube.com" || host.endsWith(".youtube.com") -> Provider.Youtube
            host == "twitch.tv" || host.endsWith(".twitch.tv") -> Provider.Twitch
            host == "tiktok.com" || host.endsWith(".tiktok.com") -> Provider.TikTok
            host == "instagram.com" || host.endsWith(".instagram.com") -> Provider.Instagram
            else -> null
        }
    }
}

// --- refusals -----------------------------------------------------------------

/**
 * Why a write was refused, as something a localised sentence can be written
 * about. Mapped from the HTTP status because that is what the Baú routes use
 * (`mapCommunityHomeError`): 403 staff only, 404 the feed is off or the post is
 * gone, 413 too large, 429 slow down, 503 no storage, 400 anything the draft
 * got wrong, with the server's own sentence attached.
 */
sealed interface BauRefusal {
    data object NotStaff : BauRefusal
    data object Unavailable : BauRefusal
    data object TooLarge : BauRefusal
    data object SlowDown : BauRefusal
    data object NoStorage : BauRefusal
    data class Invalid(val serverMessage: String?) : BauRefusal
    data object Network : BauRefusal

    /**
     * A create that died on the wire. The server may well have committed it,
     * and the post route takes no idempotency key, so a blind retry could
     * publish twice: the sentence tells the person to look first.
     */
    data object Unconfirmed : BauRefusal

    companion object {
        fun from(failure: Throwable): BauRefusal = when (failure) {
            is ApiException -> when (failure.status) {
                403 -> NotStaff
                404 -> Unavailable
                413 -> TooLarge
                429 -> SlowDown
                503 -> NoStorage
                else -> Invalid(failure.serverMessage?.takeIf { it.isNotBlank() })
            }
            else -> Network
        }
    }
}
