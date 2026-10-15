package gg.pqp.app.forward

import gg.pqp.app.core.PqpJson
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.nullable
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject

/*
 * ENCAMINHAR (forward), the Kotlin half of `packages/shared/src/forward.ts`.
 *
 * A forward is a message with one extra key, `forward`: a snapshot taken when
 * it was sent. It is absent on every ordinary message and it is plain text,
 * never re-resolved (a name inside `title` or `excerpt` is not a mention). The
 * server's `docs/FORWARD.md` is the contract; this file only reads it.
 */

/** The only snapshot version this build draws. Anything else is an ordinary message. */
const val FORWARD_VERSION = 1

/** At most this many targets in one request (`FORWARD_MAX_TARGETS`). */
const val FORWARD_MAX_TARGETS = 5

/** The forwarder's own words above the card (`FORWARD_COMMENT_MAX`). */
const val FORWARD_COMMENT_MAX = 1500

const val FORWARD_KIND_BAU_POST = "bau_post"
const val FORWARD_KIND_MESSAGE = "message"

/**
 * `messageForwardSchema`. Everything that can be absent is nullable here and
 * everything the card cannot draw without has no default, so a snapshot that
 * lacks one fails the parse and the message reads as an ordinary one.
 */
@Serializable
data class MessageForward(
    val v: Int,
    val kind: String,
    val sourceServerId: String,
    val sourceServerName: String,
    /** Root-relative like `servers.icon_url`, or null. Resolve with `Backend.absolute`. */
    val sourceServerIconUrl: String? = null,
    /** `message` only, without the `#`. */
    val sourceChannelName: String? = null,
    val sourceId: String,
    val authorDisplayName: String? = null,
    /** `bau_post` only. */
    val title: String? = null,
    /** Plain text, at most 500 characters. May be empty when [mediaKind] is set. */
    val excerpt: String = "",
    /** Only ever a stable public URL (a YouTube poster), never a signed one. */
    val mediaThumbUrl: String? = null,
    /** `image` / `video` / `youtube` / `embed`. Can be set with no thumbnail. */
    val mediaKind: String? = null,
    val url: String,
    val createdAt: String = "",
    /** Members-only post or private-channel message. Absent reads as false. */
    val restricted: Boolean = false,
) {
    val isBauPost: Boolean get() = kind == FORWARD_KIND_BAU_POST
    val isMessage: Boolean get() = kind == FORWARD_KIND_MESSAGE
}

/**
 * The field as it sits on a message, with `.catch(null)` semantics: JSON null,
 * a value that is not an object, a version this build does not know, a kind it
 * does not know, or an object missing a required key all decode to null, which
 * [gg.pqp.app.core.Message] then renders as its `body`. A bad snapshot must
 * never fail a whole history page.
 */
object LenientForwardSerializer : KSerializer<MessageForward?> {
    private val delegate = MessageForward.serializer().nullable

    override val descriptor: SerialDescriptor = delegate.descriptor

    override fun deserialize(decoder: Decoder): MessageForward? {
        val element: JsonElement = (decoder as? JsonDecoder)?.decodeJsonElement()
            ?: return delegate.deserialize(decoder)
        return parseForward(element)
    }

    override fun serialize(encoder: Encoder, value: MessageForward?) {
        delegate.serialize(encoder, value)
    }
}

/** The lenient parse behind [LenientForwardSerializer], public so a test can feed it JSON. */
fun parseForward(element: JsonElement?): MessageForward? {
    if (element == null || element is JsonNull || element !is JsonObject) return null
    val parsed = try {
        PqpJson.decodeFromJsonElement(MessageForward.serializer(), element)
    } catch (_: Exception) {
        return null
    }
    if (parsed.v != FORWARD_VERSION) return null
    if (parsed.kind != FORWARD_KIND_BAU_POST && parsed.kind != FORWARD_KIND_MESSAGE) return null
    return parsed
}

// ---------------------------------------------------------------- the fallback body

/** Prefix of the body the server writes when the forwarder adds no comment. */
const val FORWARD_FALLBACK_PREFIX = "Encaminhado: "

private const val FALLBACK_TEXT_MAX = 140

/** The set JavaScript's `\s` and `trim` know, which is wider than Kotlin's `isWhitespace`. */
private fun isJsSpace(c: Char): Boolean =
    c.isWhitespace() || c == ' ' || c == '﻿' || c == ' ' || c == '　'

private fun jsTrim(text: String): String = text.trim(::isJsSpace)

/** Runs of whitespace collapse to one space, the way the server's `replace(/\s+/g, " ")` does. */
private fun collapse(text: String): String {
    val out = StringBuilder(text.length)
    var inSpace = false
    for (c in text) {
        if (isJsSpace(c)) {
            if (!inSpace) out.append(' ')
            inSpace = true
        } else {
            out.append(c)
            inSpace = false
        }
    }
    return out.toString()
}

/**
 * `forwardFallbackBody` in `forward.ts`: `Encaminhado: <title or excerpt> <url>`,
 * the title or excerpt (or the server's name) with whitespace collapsed and cut
 * at 140 characters with `...`. Byte for byte what the server stores, because
 * [isFallbackBody] compares against it.
 */
fun forwardFallbackBody(forward: MessageForward): String {
    val first = forward.title?.let(::jsTrim)?.takeIf { it.isNotEmpty() }
        ?: jsTrim(forward.excerpt).takeIf { it.isNotEmpty() }
        ?: forward.sourceServerName
    val raw = jsTrim(collapse(first))
    val text = if (raw.length > FALLBACK_TEXT_MAX) {
        jsTrimEnd(raw.take(FALLBACK_TEXT_MAX - 3)) + "..."
    } else {
        raw
    }
    return "$FORWARD_FALLBACK_PREFIX$text ${forward.url}"
}

private fun jsTrimEnd(text: String): String = text.trimEnd(::isJsSpace)

/**
 * Whether [body] is the server's fallback rather than the forwarder's own
 * words, so the card can stand alone. A comment that merely starts with the
 * word is a comment and stays.
 */
fun isFallbackBody(body: String, forward: MessageForward): Boolean =
    body == forwardFallbackBody(forward)

/** What shows above the card: the forwarder's comment, or nothing. */
fun forwarderComment(body: String, forward: MessageForward?): String =
    if (forward != null && isFallbackBody(body, forward)) "" else body

// ---------------------------------------------------------------- request and response

/** `source` of `POST /api/forwards`. */
@Serializable
data class ForwardSource(
    val kind: String,
    val id: String,
    /** A Baú post is addressed with its server. Absent for a message. */
    val serverId: String? = null,
)

/** One destination: a channel or conversation, or a person (1:1 DM). Exactly one is set. */
@Serializable
data class ForwardTargetRef(
    val channelId: String? = null,
    val userId: String? = null,
)

@Serializable
data class CreateForwardRequest(
    val source: ForwardSource,
    val targets: List<ForwardTargetRef>,
    val comment: String? = null,
    val nonce: String? = null,
)

/** `GET /api/forwards/config`. Absent or failing reads as off. */
@Serializable
data class ForwardConfig(val enabled: Boolean = false)

/**
 * One target's answer. `ok` with a `channelId` is a card sent; otherwise
 * [reason] says why not (`no_access`, `cannot_send`, `bad_target`,
 * `stays_in_server`, `unreachable`, `slow_mode`, `rate_limited`, `automod`,
 * `unavailable`; an unknown future one is kept as is). The sent message is not
 * read: the chat already received it over the socket.
 */
@Serializable
data class ForwardResult(
    val ok: Boolean = false,
    val target: ForwardTargetRef = ForwardTargetRef(),
    val channelId: String? = null,
    val serverId: String? = null,
    val reason: String? = null,
    val retryAfterMs: Long? = null,
)

@Serializable
data class CreateForwardResponse(val results: List<ForwardResult> = emptyList())
