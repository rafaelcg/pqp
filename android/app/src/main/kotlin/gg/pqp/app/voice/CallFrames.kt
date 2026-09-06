package gg.pqp.app.voice

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put

/**
 * The ringing half of a conversation call, on the wire.
 *
 * A DM call is an ordinary voice room on the conversation's channel id: same
 * `join-voice-room`, same transport pin, same roster. What makes it a *call*
 * is the ring, and these are the five frames that carry it
 * (`packages/shared/src/signaling.ts`, "conversation calls"):
 *
 *  - `call-ring`, caller to server, sent after the caller is a live peer of
 *    the room. The server refuses it for any server channel.
 *  - `call-decline`, callee to server. Accepting has no frame of its own;
 *    joining the room IS the answer.
 *  - `call-incoming`, `call-ring-cancelled`, `call-declined`, server to the
 *    people concerned.
 *
 * Decoded here into plain values so the state machine in [CallMachine] can be
 * tested without JSON, and so a malformed frame is dropped rather than thrown
 * on: the socket is load-bearing and a strict decode would turn a new optional
 * field into a dead client.
 */
enum class CallKind { Dm, Group }

/** Who is calling, as the incoming-call surface shows them. */
data class CallerSummary(
    val userId: String,
    val displayName: String,
    val avatarUrl: String?,
)

/** One conversation ringing this device. */
data class IncomingCall(
    val conversationId: String,
    val kind: CallKind,
    val caller: CallerSummary,
)

/**
 * Why a ring stopped, in the server's words. `Answered` and `Declined` are
 * about *this* account acting on another device; the other two are the call
 * ending before anyone picked up.
 */
enum class RingEnd { Answered, Declined, Cancelled, Timeout }

sealed interface CallFrame {
    data class Incoming(val call: IncomingCall) : CallFrame
    data class RingCancelled(val conversationId: String, val reason: RingEnd) : CallFrame
    data class Declined(val conversationId: String, val userId: String) : CallFrame
}

/**
 * The call frame this JSON is, or null when it is some other frame or a call
 * frame missing a field it cannot do without.
 */
fun decodeCallFrame(frame: JsonObject): CallFrame? = when (frame.str("type")) {
    "call-incoming" -> {
        val conversationId = frame.str("conversationId")
        val kind = callKindOf(frame.str("kind"))
        val caller = (frame["caller"] as? JsonObject)?.let { caller ->
            val userId = caller.str("userId")
            val displayName = caller.str("displayName")
            if (userId == null || displayName == null) {
                null
            } else {
                CallerSummary(userId, displayName, caller.str("avatarUrl"))
            }
        }
        if (conversationId == null || kind == null || caller == null) {
            null
        } else {
            CallFrame.Incoming(IncomingCall(conversationId, kind, caller))
        }
    }

    "call-ring-cancelled" -> {
        val conversationId = frame.str("conversationId")
        val reason = ringEndOf(frame.str("reason"))
        if (conversationId == null || reason == null) {
            null
        } else {
            CallFrame.RingCancelled(conversationId, reason)
        }
    }

    "call-declined" -> {
        val conversationId = frame.str("conversationId")
        val userId = frame.str("userId")
        if (conversationId == null || userId == null) {
            null
        } else {
            CallFrame.Declined(conversationId, userId)
        }
    }

    else -> null
}

/** `callIncomingMessageSchema.kind`. Anything else is a kind this client does not know. */
fun callKindOf(wire: String?): CallKind? = when (wire) {
    "dm" -> CallKind.Dm
    "group" -> CallKind.Group
    else -> null
}

/** `callRingCancelledMessageSchema.reason`. */
fun ringEndOf(wire: String?): RingEnd? = when (wire) {
    "answered" -> RingEnd.Answered
    "declined" -> RingEnd.Declined
    "cancelled" -> RingEnd.Cancelled
    "timeout" -> RingEnd.Timeout
    else -> null
}

/** Ring the absent participants of the conversation we are a live peer of. */
fun callRingFrame(conversationId: String): JsonObject = buildJsonObject {
    put("type", "call-ring")
    put("conversationId", conversationId)
}

/** Refuse a ring. The caller is told and our other devices stop ringing. */
fun callDeclineFrame(conversationId: String): JsonObject = buildJsonObject {
    put("type", "call-decline")
    put("conversationId", conversationId)
}

private fun JsonObject.str(key: String): String? {
    val value = this[key]
    if (value == null || value is JsonNull) return null
    return (value as? JsonPrimitive)?.contentOrNull
}
