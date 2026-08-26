package gg.pqp.app.core

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive

/**
 * One decoder for the whole app.
 *
 * `ignoreUnknownKeys` is not laziness: the API grows fields (threads, embeds,
 * webhook embeds, permissions) faster than this client models them, and a
 * strict parse would turn every one of those into a channel that cannot load
 * rather than a field nobody reads.
 *
 * `explicitNulls = false` keeps outbound frames free of `"replyToId": null`,
 * which the server's zod schemas reject as a present-but-wrong-typed field
 * rather than treating as absent.
 */
val PqpJson: Json = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    coerceInputValues = true
    encodeDefaults = false
    isLenient = false
}

// --- account ---

@Serializable
data class Me(
    val id: String,
    val displayName: String,
    val username: String? = null,
    val discriminator: String? = null,
    val tag: String? = null,
    val avatarUrl: String? = null,
    val handle: String? = null,
    val bannerUrl: String? = null,
    val dmPrivacy: String = "server_members",
    /**
     * `"pending" | "passed" | "blocked"`.
     *
     * This is the one field that decides whether the rest of the API is usable
     * at all: everything except `/api/me`, the age check itself, export and
     * delete answers 403 until it reads `passed`, and the WebSocket refuses the
     * handshake outright. A client that ignores it looks broken rather than
     * unfinished.
     */
    val ageGate: String? = null,
)

// --- servers and channels ---

@Serializable
data class ServerSummary(
    val id: String,
    val name: String,
    val ownerId: String,
    val role: String? = null,
    val createdAt: String,
    val iconUrl: String? = null,
    val bannerUrl: String? = null,
    val isCommunity: Boolean = false,
)

@Serializable
data class ServersResponse(val servers: List<ServerSummary> = emptyList())

@Serializable
data class CreateServerRequest(val name: String)

@Serializable
data class CreateServerResponse(
    val server: ServerSummary,
    val channels: List<Channel> = emptyList(),
)

/**
 * What redeeming an invite answers with.
 *
 * Already being a member is a *success* and needs no special case: the server
 * inserts `ON CONFLICT DO NOTHING`, does not burn a use, and returns the same
 * server. Following a link twice therefore just takes you there.
 */
@Serializable
data class JoinInviteResponse(val serverId: String, val serverName: String = "")

/**
 * `kind` is what the row *is* (`server` / `dm` / `group`); `type` is what it
 * *carries* (`text` / `voice` / `category`). They are two different fields and
 * conflating them is how a category ends up rendered as an empty text channel.
 */
@Serializable
data class Channel(
    val id: String,
    val serverId: String? = null,
    val kind: String = "server",
    val name: String,
    val type: String,
    val position: Double = 0.0,
    val isPrivate: Boolean = false,
    val topic: String? = null,
    val parentId: String? = null,
) {
    val isText: Boolean get() = type == "text"
    val isVoice: Boolean get() = type == "voice"
    val isCategory: Boolean get() = type == "category"
}

@Serializable
data class ChannelsResponse(val channels: List<Channel> = emptyList())

// --- messages ---

@Serializable
data class Attachment(
    val id: String,
    val filename: String,
    val contentType: String,
    val byteSize: Long = 0,
    val width: Int? = null,
    val height: Int? = null,
    /** Presigned and expiring. Re-mint through `/api/attachments/:id/url`. */
    val url: String,
) {
    val isImage: Boolean get() = contentType.startsWith("image/")
}

@Serializable
data class ReplyRef(
    val id: String,
    val authorId: String? = null,
    val authorName: String? = null,
    val excerpt: String = "",
    val deleted: Boolean = false,
)

@Serializable
data class ReactionUser(val id: String, val displayName: String)

@Serializable
data class Reaction(
    val emoji: String,
    val count: Int = 0,
    val me: Boolean = false,
    val users: List<ReactionUser> = emptyList(),
)

@Serializable
data class Message(
    val id: String,
    val channelId: String,
    val authorId: String,
    val authorName: String,
    val authorTag: String? = null,
    val authorAvatarUrl: String? = null,
    val body: String = "",
    val createdAt: String,
    val editedAt: String? = null,
    val reactions: List<Reaction> = emptyList(),
    val replyTo: ReplyRef? = null,
    val attachments: List<Attachment> = emptyList(),
    val pinnedAt: String? = null,
    val isWebhook: Boolean = false,
    /**
     * On the wire but absent from `messageSchema` in `@pqp/shared`: the server
     * adds it in `mapMessage` so a blocked author's row still travels and
     * paging stays correct. Decoded defensively for the same reason iOS does.
     */
    val blocked: Boolean = false,
)

@Serializable
data class MessagesResponse(
    val messages: List<Message> = emptyList(),
    val hasMore: Boolean = false,
    val hasNewer: Boolean = false,
)

// --- voice ---

@Serializable
data class VoiceParticipant(
    val peerId: String,
    val userId: String,
    val displayName: String,
    val avatarUrl: String? = null,
    val sharingScreen: Boolean = false,
    val cameraStreamId: String? = null,
    val screenAudioStreamId: String? = null,
    val muted: Boolean = false,
    val deafened: Boolean = false,
)

/**
 * `urls` is a string on some entries and an array on others, which is what the
 * WebRTC spec allows and what `iceServerSchema` mirrors. Decoded as a raw
 * element and normalised here, because a Kotlin field cannot be both.
 */
@Serializable
data class IceServer(
    val urls: JsonElement,
    val username: String? = null,
    val credential: String? = null,
) {
    val urlList: List<String>
        get() = when (urls) {
            is JsonPrimitive -> listOf(urls.content)
            else -> urls.let { element ->
                runCatching {
                    (element as kotlinx.serialization.json.JsonArray).map { it.jsonPrimitive.content }
                }.getOrDefault(emptyList())
            }
        }
}

@Serializable
data class IceServersResponse(val iceServers: List<IceServer> = emptyList())

@Serializable
data class VoiceBackendResponse(@SerialName("backend") val backend: String = "mesh")

// --- errors ---

@Serializable
data class ApiError(val error: String? = null, val code: String? = null)
