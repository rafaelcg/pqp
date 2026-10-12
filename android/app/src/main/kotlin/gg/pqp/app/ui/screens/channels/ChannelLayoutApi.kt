package gg.pqp.app.ui.screens.channels

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.emptyPreferences
import androidx.datastore.preferences.preferencesDataStore
import gg.pqp.app.core.ApiClient
import gg.pqp.app.core.ApiException
import gg.pqp.app.core.Channel
import gg.pqp.app.core.PqpJson
import gg.pqp.app.social.getJson
import java.io.IOException
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * Which channel list to draw. Null on a 404: an older server with no mixed
 * list, so the old one. Any other failure throws, and the screen keeps what
 * it was drawing.
 */
suspend fun ApiClient.channelLayoutConfig(serverId: String): ChannelLayoutConfig? = try {
    getJson<ChannelLayoutConfig>("/api/servers/$serverId/channel-layout")
} catch (e: ApiException) {
    if (e.status == 404) null else throw e
}

@Serializable
private data class SavedLayout(val channels: List<Channel>? = null, val version: Int = 0)

/**
 * The whole list's order in one write (Organizar canais). Every refusal the
 * screen has an answer for comes back as a value; the transport and the
 * statuses it has no answer for throw.
 */
suspend fun ApiClient.applyChannelLayout(serverId: String, payload: ChannelLayoutPayload): ChannelLayoutSaveResult {
    val request = Request.Builder()
        .url(url("/api/servers/$serverId/channel-layout"))
        .put(payload.toJson().toString().toRequestBody(ApiClient.JSON_MEDIA_TYPE))
    return try {
        val saved = decode<SavedLayout>(execute(request))
        ChannelLayoutSaveResult.Saved(saved.channels, saved.version)
    } catch (e: ApiException) {
        channelLayoutRefusal(e) ?: throw e
    }
}

/**
 * What a refused PUT means, or null when the screen has no answer for it.
 * Split out so the mapping is tested without a server.
 */
fun channelLayoutRefusal(e: ApiException): ChannelLayoutSaveResult? {
    val body = e.body
    val error = e.serverMessage ?: body?.get("error")?.jsonPrimitive?.contentOrNull
    return when {
        e.status == 409 && error == "channel_layout_stale" -> {
            val channels = body?.get("channels")?.let {
                runCatching { PqpJson.decodeFromJsonElement(ListSerializer(Channel.serializer()), it) }.getOrNull()
            }
            val version = body?.get("version")?.jsonPrimitive?.intOrNull
            if (channels != null && version != null) ChannelLayoutSaveResult.Stale(channels, version) else null
        }
        e.status == 409 && error == "channel_layout_off" -> ChannelLayoutSaveResult.Off
        e.status == 400 -> ChannelLayoutSaveResult.Invalid(error ?: "HTTP 400")
        else -> null
    }
}

@Serializable
private data class ChannelResponse(val channel: Channel)

/**
 * `POST /api/servers/:id/channels`. [parentId] is ALWAYS sent for a channel
 * (null for no category) and never for a category: a request without the key
 * is how the server recognises an older client and files its channel into the
 * first category (the legacy-create rule). Built by hand because `PqpJson`
 * drops nulls.
 */
fun createChannelBody(name: String, type: String, isPrivate: Boolean, parentId: String?): JsonObject = buildJsonObject {
    put("name", JsonPrimitive(name))
    put("type", JsonPrimitive(type))
    put("isPrivate", JsonPrimitive(isPrivate))
    if (type != "category") put("parentId", parentId?.let(::JsonPrimitive) ?: JsonNull)
}

suspend fun ApiClient.createChannel(
    serverId: String,
    name: String,
    type: String,
    isPrivate: Boolean = false,
    parentId: String? = null,
): Channel {
    val body = createChannelBody(name, type, isPrivate, parentId).toString()
    val request = Request.Builder()
        .url(url("/api/servers/$serverId/channels"))
        .post(body.toRequestBody(ApiClient.JSON_MEDIA_TYPE))
    return decode<ChannelResponse>(execute(request)).channel
}

/** `PATCH /api/channels/:id` with a new name. */
suspend fun ApiClient.renameChannel(channelId: String, name: String): Channel {
    val body = buildJsonObject { put("name", JsonPrimitive(name)) }.toString()
    val request = Request.Builder()
        .url(url("/api/channels/$channelId"))
        .patch(body.toRequestBody(ApiClient.JSON_MEDIA_TYPE))
    return decode<ChannelResponse>(execute(request)).channel
}

private val Context.channelLayoutDataStore by preferencesDataStore(name = "channel_layout")

/**
 * The last `mixed` answer this device saw for a server, so a server in the
 * mixed list opens straight into it instead of flashing the old one while the
 * config request is in flight. The version is never remembered: a save made
 * before the fresh answer lands sends 0 and gets a 409 with the real one.
 */
class ChannelLayoutMemory(private val context: Context) {
    private fun key(serverId: String) = booleanPreferencesKey("mixed:$serverId")

    suspend fun load(serverId: String): ChannelLayoutConfig {
        val mixed = context.channelLayoutDataStore.data
            .catch { error -> if (error is IOException) emit(emptyPreferences()) else throw error }
            .map { it[key(serverId)] == true }
            .first()
        return if (mixed) ChannelLayoutConfig(mixed = true, version = 0) else ChannelLayoutConfig.Legacy
    }

    suspend fun save(serverId: String, config: ChannelLayoutConfig) {
        runCatching {
            context.channelLayoutDataStore.edit { prefs ->
                if (config.mixed) prefs[key(serverId)] = true else prefs.remove(key(serverId))
            }
        }
    }
}
