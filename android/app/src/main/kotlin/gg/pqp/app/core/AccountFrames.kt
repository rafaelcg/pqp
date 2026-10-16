package gg.pqp.app.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/*
 * The two account-addressed frames the server sends to every socket of one person:
 * `server-removed` (a kick, a ban or a delete took a server away) and `own-status`
 * (another device of this account changed its status). Neither is a channel fan-out,
 * which is why neither is in `CHAT_SERVER_MESSAGE_TYPES`; the web handles them in
 * `client/src/App.tsx` and `client/src/hooks/use-status.ts`, and this is the same rule.
 */

/** `serverRemovedSchema`'s `reason`. */
enum class ServerRemovedReason(val wire: String) {
    Kicked("kicked"),
    Banned("banned"),
    Deleted("deleted"),
    ;

    companion object {
        fun fromWire(value: String?): ServerRemovedReason? = entries.firstOrNull { it.wire == value }
    }
}

/** A `server-removed` frame, once it is known to name a server and a reason this build understands. */
data class ServerRemoved(val serverId: String, val reason: ServerRemovedReason)

/** What the app is told when one of its servers went away: enough to leave it and say why. */
data class ServerGone(
    val serverId: String,
    val serverName: String,
    val reason: ServerRemovedReason,
    /** The owner's own delete: they just did it, telling them again is noise. */
    val quiet: Boolean,
)

object AccountFrames {

    /** `null` for a frame of another type, or one missing its server or carrying a reason this build does not know. */
    fun serverRemoved(frame: JsonObject): ServerRemoved? {
        if (text(frame, "type") != "server-removed") return null
        val id = text(frame, "serverId")?.takeIf { it.isNotBlank() } ?: return null
        val reason = ServerRemovedReason.fromWire(text(frame, "reason")) ?: return null
        return ServerRemoved(id, reason)
    }

    /**
     * What the removal means for this phone's list: the server is dropped, and
     * [ServerGone] says what to tell the person. `null` when the phone does not
     * hold the server (the frame carries no name: a client that does not hold the
     * server has nothing to update and nothing to say).
     */
    fun apply(held: List<ServerSummary>, removed: ServerRemoved): Pair<List<ServerSummary>, ServerGone>? {
        val gone = held.firstOrNull { it.id.equals(removed.serverId, ignoreCase = true) } ?: return null
        val quiet = removed.reason == ServerRemovedReason.Deleted && gone.role == "owner"
        return held.filterNot { it === gone } to ServerGone(gone.id, gone.name, removed.reason, quiet)
    }

    /** The manual status an `own-status` frame carries, or `null` for any other frame or a value this build does not know. */
    fun ownStatus(frame: JsonObject): String? {
        if (text(frame, "type") != "own-status") return null
        return text(frame, "status")?.takeIf { it in OwnStatus.CHOICES }
    }

    private fun text(frame: JsonObject, key: String): String? = (frame[key] as? JsonPrimitive)?.contentOrNull
}

/** `manualStatusSchema`. What an account may set about itself. Absent from storage means online. */
object OwnStatus {
    val CHOICES = listOf("online", "away", "dnd", "invisible")
    const val DEFAULT = "online"

    /** What a stored value reads as: an unknown one is the default, as on the web. */
    fun read(stored: String?): String = stored?.takeIf { it in CHOICES } ?: DEFAULT

    /**
     * What a finished save settled on, against the frames that arrived while it was in the
     * air. The server sends `own-status` to EVERY socket of the account, this one included,
     * so one of them is usually the echo of the very write in flight; adopting it mid-save
     * would fight the optimistic value, so frames are held until the write settles.
     * Frames that all agree with the settled value are that echo (or another device picking
     * the same thing) and need nothing. A disagreeing one means two devices wrote at once, and
     * arrival order cannot say which one the server kept, so the stored value is read back.
     */
    fun needsReadBack(settled: String, held: List<String>): Boolean = held.any { it != settled }
}

@Serializable
private data class StatusPatch(val status: String)

/** `PATCH /api/me/preferences` with `status`: a one-key patch, which the server merges. */
suspend fun ApiClient.setStatus(status: String) {
    val body = PqpJson.encodeToString(StatusPatch.serializer(), StatusPatch(status))
    execute(
        Request.Builder()
            .url(url("/api/me/preferences"))
            .patch(body.toRequestBody(ApiClient.JSON_MEDIA_TYPE)),
    ).close()
}
