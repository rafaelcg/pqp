package gg.pqp.app.activities

import gg.pqp.app.core.PqpJson
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/**
 * The six server frames of an app session (`appServerFrameSchema` in
 * `packages/shared/src/apps/frames.ts`), decoded, and the four this client
 * sends (`appClientFrameSchema`).
 *
 * `channel-app` goes to every socket whose account can VIEW the channel, on
 * every instance, so the live indicator needs no channel subscription. The
 * other five reach only the sockets seated in the session (plus `app-ended`,
 * which also reaches the channel's other viewers so the card can turn into a
 * record).
 */
sealed interface ActivityFrame {
    /** `session == null` means nothing is live in [channelId] any more. */
    data class ChannelApp(val channelId: String, val session: ActivitySession?) : ActivityFrame

    data class Snapshot(
        val sessionId: String,
        val seatId: String,
        val role: String,
        val isHost: Boolean,
        val stateRev: Long,
        val stateValue: JsonElement,
        val participants: List<SeatParticipant>,
    ) : ActivityFrame

    data class State(val sessionId: String, val rev: Long, val value: JsonElement) : ActivityFrame

    data class Event(
        val sessionId: String,
        val fromSeatId: String,
        val name: String,
        val data: JsonElement,
    ) : ActivityFrame

    data class Ended(
        val sessionId: String,
        val channelId: String,
        val reason: ActivityEndReason,
        val participants: Int,
        val durationSeconds: Int,
    ) : ActivityFrame

    data class Error(val sessionId: String, val op: String, val code: String) : ActivityFrame

    companion object {
        val TYPES = setOf("channel-app", "app-session", "app-state", "app-event", "app-ended", "app-error")

        /** True for a type this decoder owns, whether or not the frame then decodes. */
        fun isActivity(frame: JsonObject): Boolean = frame["type"]?.jsonPrimitive?.contentOrNull in TYPES

        /**
         * Null for any other frame and for one that does not decode: a frame the
         * phone cannot read is a frame it waits out (the next read says the
         * same thing), never a crash.
         */
        fun decode(frame: JsonObject): ActivityFrame? = runCatching {
            fun string(key: String): String? = frame[key]?.jsonPrimitive?.contentOrNull
            when (string("type")) {
                "channel-app" -> {
                    val channelId = string("channelId") ?: return@runCatching null
                    val session = frame["session"]?.takeIf { it !is kotlinx.serialization.json.JsonNull }
                        ?.let { PqpJson.decodeFromJsonElement(ActivitySession.serializer(), it) }
                    ChannelApp(channelId, session)
                }

                "app-session" -> {
                    val state = frame["state"]?.jsonObject
                    Snapshot(
                        sessionId = string("sessionId") ?: return@runCatching null,
                        seatId = string("seatId") ?: return@runCatching null,
                        role = string("role") ?: "player",
                        isHost = frame["isHost"]?.jsonPrimitive?.booleanOrNull == true,
                        stateRev = state?.get("rev")?.jsonPrimitive?.longOrNull ?: 0L,
                        stateValue = state?.get("value") ?: kotlinx.serialization.json.JsonNull,
                        participants = ((frame["participants"] as? JsonArray)?.toList() ?: emptyList()).mapNotNull { SeatParticipant.decode(it) },
                    )
                }

                "app-state" -> State(
                    sessionId = string("sessionId") ?: return@runCatching null,
                    rev = frame["rev"]?.jsonPrimitive?.longOrNull ?: return@runCatching null,
                    value = frame["value"] ?: kotlinx.serialization.json.JsonNull,
                )

                "app-event" -> Event(
                    sessionId = string("sessionId") ?: return@runCatching null,
                    fromSeatId = string("fromSeatId") ?: return@runCatching null,
                    name = string("name") ?: return@runCatching null,
                    data = frame["data"] ?: kotlinx.serialization.json.JsonNull,
                )

                "app-ended" -> {
                    val summary = frame["summary"] as? JsonObject
                    Ended(
                        sessionId = string("sessionId") ?: return@runCatching null,
                        channelId = string("channelId") ?: return@runCatching null,
                        reason = ActivityEndReason.of(string("reason")),
                        participants = summary?.get("participants")?.jsonPrimitive?.intOrNull ?: 0,
                        durationSeconds = summary?.get("durationSeconds")?.jsonPrimitive?.intOrNull ?: 0,
                    )
                }

                "app-error" -> Error(
                    sessionId = string("sessionId") ?: return@runCatching null,
                    op = string("op") ?: return@runCatching null,
                    code = string("code") ?: "unavailable",
                )

                else -> null
            }
        }.getOrNull()

        // --- what the phone sends ---

        fun join(sessionId: String, asSpectator: Boolean): JsonObject = buildJsonObject {
            put("type", "app-join")
            put("sessionId", sessionId)
            if (asSpectator) put("asSpectator", true)
        }

        fun leave(sessionId: String): JsonObject = buildJsonObject {
            put("type", "app-leave")
            put("sessionId", sessionId)
        }

        fun statePatch(sessionId: String, patch: JsonElement, baseRev: Long?): JsonObject = buildJsonObject {
            put("type", "app-state-patch")
            put("sessionId", sessionId)
            if (baseRev != null) put("baseRev", baseRev)
            put("patch", patch)
        }

        fun eventSend(sessionId: String, name: String, data: JsonElement): JsonObject = buildJsonObject {
            put("type", "app-event-send")
            put("sessionId", sessionId)
            put("name", name)
            put("data", data)
        }
    }
}

/** One seated person in an `app-session` snapshot: the seat id is the only identifier the app ever sees. */
data class SeatParticipant(
    val seatId: String,
    val userId: String,
    val role: String,
    val isHost: Boolean,
    val connection: String,
    val appUserId: String?,
) {
    companion object {
        fun decode(element: JsonElement): SeatParticipant? = runCatching {
            val o = element.jsonObject
            SeatParticipant(
                seatId = o["seatId"]?.jsonPrimitive?.contentOrNull ?: return@runCatching null,
                userId = o["userId"]?.jsonPrimitive?.contentOrNull ?: return@runCatching null,
                role = o["role"]?.jsonPrimitive?.contentOrNull ?: "player",
                isHost = o["isHost"]?.jsonPrimitive?.booleanOrNull == true,
                connection = o["connection"]?.jsonPrimitive?.contentOrNull ?: "present",
                appUserId = o["appUserId"]?.jsonPrimitive?.contentOrNull,
            )
        }.getOrNull()
    }
}
