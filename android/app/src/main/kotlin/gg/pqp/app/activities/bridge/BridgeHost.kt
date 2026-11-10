package gg.pqp.app.activities.bridge

import gg.pqp.app.activities.ActivityApp
import gg.pqp.app.activities.ActivityEndReason
import gg.pqp.app.activities.SeatParticipant
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/**
 * The phone's half of the sandbox message API (`packages/shared/src/apps/bridge.ts`,
 * v1), one per running activity: the Kotlin counterpart of
 * `client/src/lib/apps/bridge-host.ts`. The app is untrusted, so:
 *
 * - every message from it is parsed strictly (an unknown key is a rejection)
 *   and answered `invalid`, or dropped when it carries no usable request id;
 * - the manifest's caps are enforced here AGAIN (the server enforces them for
 *   real): events per second and bytes, state bytes after the patch, who may
 *   write;
 * - what goes back is built from scratch: a participant is a seat id, a cleaned
 *   name and an avatar data URL, never a pqp user id, and nothing here ever
 *   holds a token (the API client lives somewhere this class cannot reach);
 * - a flood is answered `rate-limited` without parsing, and a sustained one is
 *   reported through [Hooks.onViolation].
 *
 * What a phone does not have, it says so about, in the contract's words: a
 * device store, local files and Saves na conta answer `unavailable` (the
 * wrapper page answers those, see `ActivityWebHost`: their payloads are binary
 * and never need to reach Kotlin), a pane share answers `not-allowed`.
 *
 * Everything runs on one thread, the main one: the web view calls in there and
 * the coroutines are launched there. Only avatar fetching leaves it, inside
 * [ActivityPeople.describe].
 */
class BridgeHost(
    private val app: ActivityApp,
    private val transport: ActivityTransport,
    private val people: ActivityPeople,
    private val env: Env,
    private val post: (String) -> Unit,
    private val scope: CoroutineScope,
    private val hooks: Hooks = Hooks(),
    private val now: () -> Long = System::currentTimeMillis,
    private val log: (String) -> Unit = {},
) {
    /** What the page tells the app about itself: language, theme, motion. Read at `hello` and on a refresh. */
    interface Env {
        fun locale(): String
        fun theme(): Map<String, String>
        fun reducedMotion(): Boolean
    }

    class Hooks(
        /** `ui.fullscreen`: hide the page's own chrome. Returns whether the app is full screen now. */
        val fullscreen: (Boolean) -> Boolean = { false },
        /** `ui.activity`: playing, paused or browsing. Answered and otherwise ignored. */
        val onActivity: (String) -> Unit = {},
        val onViolation: () -> Unit = {},
        val onEnded: (ActivityEndReason) -> Unit = {},
    )

    private val stateCap = StateCap(
        maxBytes = minOf(app.state?.maxBytes ?: STATE_MAX_BYTES, STATE_MAX_BYTES),
        writers = app.state?.writers ?: "participants",
    )
    private val eventMaxPerSecond = minOf(app.events?.maxPerSecond ?: EVENT_MAX_PER_SECOND, EVENT_MAX_PER_SECOND)
    private val eventMaxBytes = minOf(app.events?.maxBytes ?: EVENT_MAX_BYTES, EVENT_MAX_BYTES)
    private val eventBucket = TokenBucket(eventMaxPerSecond.toDouble(), maxOf(1, eventMaxPerSecond), now)
    private val writes = minOf(app.state?.maxWritesPerSecond ?: STATE_MAX_WRITES_PER_SECOND, STATE_MAX_WRITES_PER_SECOND)
    private val stateBucket = TokenBucket(writes.toDouble(), maxOf(1, writes), now)
    private val floodBucket = TokenBucket(FLOOD_RATE_PER_SECOND.toDouble(), FLOOD_BURST, now)

    private data class StateCap(val maxBytes: Int, val writers: String)

    private var floodStrikes = 0
    private var violated = false
    private var attached = false
    private var detached = false
    private var unsubscribe: (() -> Unit)? = null
    private var snapshot: SeatSnapshot? = null
    private var stateRev: Long = 0
    private var stateValue: JsonElement = JsonNull
    private var stateKnown = false
    private var roster: List<BridgeParticipant> = emptyList()
    private var rosterSeq = 0
    private var rosterReady: Deferred<Unit>? = null
    private var online = true
    private var endedReason: ActivityEndReason? = null
    private var theme: Map<String, String> = emptyMap()

    /** Whether the session is over, and why. */
    val ended: ActivityEndReason? get() = endedReason

    // --- lifecycle ---

    /** Subscribes to the session and takes a seat. Throws an [ActivityTransportError]. */
    suspend fun start(asSpectator: Boolean) {
        unsubscribe = transport.subscribe(
            object : ActivityTransport.Handlers {
                override fun onSession(snapshot: SeatSnapshot) = applySnapshot(snapshot)
                override fun onState(rev: Long, value: JsonElement) = applyState(rev, value)
                override fun onEvent(fromSeatId: String, name: String, data: JsonElement) {
                    push("event") {
                        put("fromSeatId", fromSeatId)
                        put("name", name)
                        put("data", data)
                    }
                }

                override fun onConnection(online: Boolean) = setConnection(online)
                override fun onEnded(reason: ActivityEndReason) = setEnded(reason)
            },
        )
        try {
            val joined = transport.join(asSpectator)
            if (detached) {
                // the screen went away while the join was in flight: the seat it just got has no owner
                unsubscribe?.invoke()
                unsubscribe = null
                transport.leave()
                return
            }
            applySnapshot(joined)
        } catch (e: Throwable) {
            unsubscribe?.invoke()
            unsubscribe = null
            throw e
        }
    }

    /** The wrapper page handed the app its port: send `hello`. Call after [start] returned. */
    fun attach() {
        val snap = snapshot ?: return
        if (detached || attached) return
        attached = true
        theme = env.theme()
        post(
            buildJsonObject {
                // Not a `/ws` frame: a bridge push, so it is spelled through a constant the frame scan does not read.
                put("type", HELLO)
                put("platformApi", PLATFORM_API)
                put(
                    "app",
                    buildJsonObject {
                        put("id", app.id)
                        put("version", app.version)
                    },
                )
                put("locale", safeLocale())
                put("theme", themeJson(theme))
                put("reducedMotion", env.reducedMotion())
                put(
                    "self",
                    buildJsonObject {
                        put("seatId", snap.seatId)
                        put("role", snap.role)
                        put("isHost", snap.isHost)
                    },
                )
                put("connection", if (online) "online" else "reconnecting")
            }.toString(),
        )
    }

    /** Stops talking to the app. The seat is not released: [leave] does that. */
    fun detach() {
        detached = true
        unsubscribe?.invoke()
        unsubscribe = null
    }

    /** Releases the seat (not held for the resume window). A session that already ended has nothing to leave. */
    fun leave() {
        if (snapshot != null && endedReason == null) transport.leave()
    }

    /** The page's theme changed (light or dark, a new accent): tell the app, once, when it differs. */
    fun refreshTheme() {
        if (!attached) return
        val next = env.theme()
        if (next == theme) return
        theme = next
        push("theme") { put("theme", themeJson(next)) }
    }

    // --- what the session tells us ---

    private fun applySnapshot(next: SeatSnapshot) {
        snapshot = next
        applyState(next.stateRev, next.stateValue)
        rosterReady = scope.async { refreshRoster(next) }
    }

    private fun applyState(rev: Long, value: JsonElement) {
        // a revision never goes backwards, and the same revision is a duplicate (a resume re-sends it)
        if (stateKnown && rev <= stateRev) return
        stateKnown = true
        stateRev = rev
        stateValue = value
        push("state") {
            put("rev", rev)
            put("value", value)
        }
    }

    private suspend fun refreshRoster(next: SeatSnapshot) {
        val seq = ++rosterSeq
        val built = coroutineScope {
            next.participants.map { seat -> async { build(seat) } }.map { it.await() }
        }
        if (seq != rosterSeq || detached) return // a newer snapshot superseded this one
        val mapped = fitAvatarBudget(built.filterNotNull())
        if (mapped == roster) return
        roster = mapped
        push("participants") { put("participants", participantsJson(mapped)) }
    }

    private suspend fun build(seat: SeatParticipant): BridgeParticipant? {
        val person = try {
            people.describe(seat.userId)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            null
        }
        if (!SEAT_ID.matches(seat.seatId)) return null
        return BridgeParticipant(
            seatId = seat.seatId,
            displayName = cleanDisplayName(person?.displayName),
            avatar = person?.avatarDataUrl?.takeIf { it.length <= AVATAR_MAX_CHARS && AVATAR_URL.containsMatchIn(it) },
            role = seat.role,
            isHost = seat.isHost,
            connection = seat.connection,
            appUserId = seat.appUserId?.takeIf { APP_USER_ID.matches(it) },
        )
    }

    private fun setConnection(nowOnline: Boolean) {
        if (online == nowOnline) return
        online = nowOnline
        push("connection") { put("status", if (nowOnline) "online" else "reconnecting") }
    }

    private fun setEnded(reason: ActivityEndReason) {
        if (endedReason != null) return
        endedReason = reason
        push("session.ended") { put("reason", reason.wire.takeUnless { reason == ActivityEndReason.Other } ?: "idle") }
        hooks.onEnded(reason)
    }

    private fun safeLocale(): String = env.locale().takeIf { LOCALE.matches(it) } ?: "en"

    // --- sending to the app ---

    private fun push(type: String, fields: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit) {
        if (!attached || detached) return
        post(
            buildJsonObject {
                put("type", type)
                fields()
            }.toString(),
        )
    }

    private fun fail(id: String, error: String) {
        if (detached) return
        post(
            buildJsonObject {
                put("id", id)
                put("ok", false)
                put("error", error)
            }.toString(),
        )
    }

    private fun succeed(id: String, type: String, result: JsonElement) {
        if (detached) return
        post(
            buildJsonObject {
                put("id", id)
                put("ok", true)
                put("type", type)
                put("result", result)
            }.toString(),
        )
    }

    // --- receiving from the app ---

    /**
     * One message the app put on its port, as the wrapper page relayed it (a JSON
     * string). Never throws: a message that cannot be read is dropped or answered
     * `invalid`.
     */
    fun onPortMessage(raw: String) {
        if (detached) return
        val parsed = runCatching { kotlinx.serialization.json.Json.parseToJsonElement(raw) }.getOrNull() as? JsonObject
            ?: return
        if (!floodBucket.take()) {
            floodStrikes += 1
            idOf(parsed)?.let { fail(it, "rate-limited") }
            if (floodStrikes >= FLOOD_STRIKES_BEFORE_VIOLATION && !violated) {
                violated = true
                hooks.onViolation()
            }
            return
        }
        val request = parseRequest(parsed)
        if (request == null) {
            idOf(parsed)?.let { fail(it, "invalid") }
            return
        }
        scope.launch {
            try {
                handle(request)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                log("handling ${request.type} threw: ${e.message}")
                fail(request.id, "unavailable")
            }
        }
    }

    private suspend fun handle(request: Request) {
        val id = request.id
        if (endedReason != null) return fail(id, "ended")
        val snap = snapshot ?: return fail(id, "unavailable")
        when (request) {
            is Request.ParticipantsGet -> {
                // a newer snapshot replaces the roster job while this waits: wait again until it is the latest
                while (true) {
                    val ready = rosterReady
                    ready?.await()
                    if (ready === rosterReady) break
                }
                succeed(id, request.type, buildJsonObject { put("participants", participantsJson(roster)) })
            }

            is Request.StateGet -> succeed(
                id,
                request.type,
                buildJsonObject {
                    put("rev", stateRev)
                    put("value", stateValue)
                },
            )

            is Request.StatePatch -> {
                checkStateWrite(snap, request.patch)?.let { return fail(id, it) }
                try {
                    val rev = transport.patchState(request.patch, request.baseRev)
                    succeed(id, request.type, buildJsonObject { put("rev", rev) })
                } catch (e: ActivityTransportError) {
                    fail(id, mapTransportError(e.code, forEnd = false))
                }
            }

            is Request.EventsSend -> {
                checkEventSend(request.data)?.let { return fail(id, it) }
                transport.sendEvent(request.name, request.data)
                succeed(id, request.type, JsonNull)
            }

            is Request.UiResize -> succeed(id, request.type, buildJsonObject { put("height", request.height) })

            is Request.UiFullscreen -> succeed(id, request.type, buildJsonObject { put("on", hooks.fullscreen(request.on)) })

            // A phone cannot start a pane share: the platform says not-allowed and an app draws nothing.
            is Request.ShareRequest -> fail(id, "not-allowed")

            is Request.UiActivity -> {
                runCatching { hooks.onActivity(request.state) }
                succeed(id, request.type, JsonNull)
            }

            is Request.SessionEnd -> {
                if (!snap.isHost) return fail(id, "not-host")
                try {
                    transport.end()
                    succeed(id, request.type, JsonNull)
                } catch (e: ActivityTransportError) {
                    fail(id, mapTransportError(e.code, forEnd = true))
                }
            }
        }
    }

    private fun checkStateWrite(snap: SeatSnapshot, patch: JsonElement): String? {
        if (!online) return "unavailable"
        if (stateCap.writers == "host" && !snap.isHost) return "not-host"
        if (!stateBucket.take()) return "rate-limited"
        if (jsonProblem(patch) != null) return "invalid"
        if (stateBytesAfter(stateValue, patch) > stateCap.maxBytes) return "too-large"
        return null
    }

    private fun checkEventSend(data: JsonElement): String? {
        if (!online) return "unavailable"
        if (eventMaxPerSecond == 0 || eventMaxBytes == 0) return "not-allowed"
        if (jsonProblem(data) != null) return "invalid"
        if (jsonByteLength(data) > eventMaxBytes) return "too-large"
        if (!eventBucket.take()) return "rate-limited"
        return null
    }

    // --- the request grammar ---

    /** A request the bridge answers natively: the strict `bridgeAppMessageSchema` cases that need no binary. */
    sealed interface Request {
        val id: String
        val type: String

        data class ParticipantsGet(override val id: String) : Request { override val type = "participants.get" }
        data class StateGet(override val id: String) : Request { override val type = "state.get" }
        data class StatePatch(override val id: String, val patch: JsonElement, val baseRev: Long?) : Request {
            override val type = "state.patch"
        }
        data class EventsSend(override val id: String, val name: String, val data: JsonElement) : Request {
            override val type = "events.send"
        }
        data class UiResize(override val id: String, val height: Int) : Request { override val type = "ui.resize" }
        data class UiFullscreen(override val id: String, val on: Boolean) : Request { override val type = "ui.fullscreen" }
        data class ShareRequest(override val id: String, val on: Boolean) : Request { override val type = "share.request" }
        data class UiActivity(override val id: String, val state: String) : Request { override val type = "ui.activity" }
        data class SessionEnd(override val id: String) : Request { override val type = "session.end" }
    }

    private fun idOf(raw: JsonObject): String? =
        (raw["id"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it.length in 1..32 }

    /** Strict: an unknown key, a missing one or one of the wrong kind is a rejection (null). */
    internal fun parseRequest(raw: JsonObject): Request? {
        val id = idOf(raw) ?: return null
        val type = (raw["type"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
        fun only(vararg keys: String): Boolean = raw.keys.all { it == "id" || it == "type" || it in keys }
        fun bool(key: String): Boolean? = (raw[key] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull
        return when (type) {
            "participants.get" -> if (only()) Request.ParticipantsGet(id) else null
            "state.get" -> if (only()) Request.StateGet(id) else null
            "session.end" -> if (only()) Request.SessionEnd(id) else null
            "state.patch" -> {
                if (!only("patch", "baseRev")) return null
                val patch = raw["patch"] ?: return null
                val baseRev = raw["baseRev"]?.let { element ->
                    val p = element as? JsonPrimitive ?: return null
                    if (p.isString) return null
                    p.longOrNull?.takeIf { it >= 0 } ?: return null
                }
                Request.StatePatch(id, patch, baseRev)
            }
            "events.send" -> {
                if (!only("name", "data")) return null
                val name = (raw["name"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
                if (!EVENT_NAME.matches(name)) return null
                Request.EventsSend(id, name, raw["data"] ?: return null)
            }
            "ui.resize" -> {
                if (!only("height")) return null
                val height = (raw["height"] as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull ?: return null
                if (height !in UI_MIN_HEIGHT..UI_MAX_HEIGHT) return null
                Request.UiResize(id, height.toInt())
            }
            "ui.fullscreen" -> if (only("on")) Request.UiFullscreen(id, bool("on") ?: return null) else null
            "share.request" -> if (only("on")) Request.ShareRequest(id, bool("on") ?: return null) else null
            "ui.activity" -> {
                if (!only("state")) return null
                val state = (raw["state"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
                if (state !in ACTIVITY_STATES) return null
                Request.UiActivity(id, state)
            }
            else -> null
        }
    }

    // --- participants as the app sees them ---

    data class BridgeParticipant(
        val seatId: String,
        val displayName: String,
        val avatar: String?,
        val role: String,
        val isHost: Boolean,
        val connection: String,
        val appUserId: String?,
    )

    private fun participantsJson(list: List<BridgeParticipant>): JsonArray = buildJsonArray {
        for (p in list) {
            add(
                buildJsonObject {
                    put("seatId", p.seatId)
                    put("displayName", p.displayName)
                    put("avatar", p.avatar?.let { JsonPrimitive(it) } ?: JsonNull)
                    put("role", p.role)
                    put("isHost", p.isHost)
                    put("connection", p.connection)
                    if (p.appUserId != null) put("appUserId", p.appUserId)
                },
            )
        }
    }

    private fun themeJson(theme: Map<String, String>): JsonObject = buildJsonObject {
        for ((k, v) in theme.entries.take(THEME_MAX_TOKENS)) {
            if (THEME_KEY.matches(k) && v.length <= 256) put(k, v)
        }
    }

    companion object {
        const val PLATFORM_API = 1
        private const val HELLO = "hello"
        const val STATE_MAX_BYTES = 16384
        const val EVENT_MAX_BYTES = 1024
        const val EVENT_MAX_PER_SECOND = 20
        const val STATE_MAX_WRITES_PER_SECOND = 10
        const val AVATAR_MAX_CHARS = 65536
        const val AVATAR_BUDGET_CHARS = 4 * 1024 * 1024
        const val DISPLAY_NAME_MAX_CHARS = 64
        const val THEME_MAX_TOKENS = 64
        const val UI_MIN_HEIGHT = 120L
        const val UI_MAX_HEIGHT = 2000L
        private const val FLOOD_RATE_PER_SECOND = 100
        private const val FLOOD_BURST = 200
        private const val FLOOD_STRIKES_BEFORE_VIOLATION = 500

        private val SEAT_ID = Regex("^[A-Za-z0-9_-]{16,32}$")
        private val APP_USER_ID = Regex("^[A-Za-z0-9_-]{16,128}$")
        private val EVENT_NAME = Regex("^[a-z][a-z0-9.-]{0,31}$")
        private val LOCALE = Regex("^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$")
        private val THEME_KEY = Regex("^--[A-Za-z0-9_-]{1,64}$")
        private val AVATAR_URL = Regex("^data:image/[a-z0-9.+-]+[;,]")
        private val ACTIVITY_STATES = setOf("playing", "paused", "browsing")

        // control characters and the bidirectional overrides and isolates
        private val UNSAFE_NAME_CHARS = Regex("[\\u0000-\\u001f\\u007f-\\u009f\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]")

        /** A name an app may draw: no control or bidi characters, trimmed, at most 64 UTF-16 units, never empty. */
        fun cleanDisplayName(name: String?): String {
            val cleaned = (name ?: "").replace(UNSAFE_NAME_CHARS, "").trim()
            val out = StringBuilder()
            var i = 0
            while (i < cleaned.length) {
                val cp = cleaned.codePointAt(i)
                val width = Character.charCount(cp)
                if (out.length + width > DISPLAY_NAME_MAX_CHARS) break
                out.appendCodePoint(cp)
                i += width
            }
            return out.toString().ifEmpty { "?" }
        }

        /**
         * A roster's avatars add up to at most [AVATAR_BUDGET_CHARS]. Past that the
         * largest are left out (the app draws its own fallback) until the rest fit.
         */
        fun fitAvatarBudget(list: List<BridgeParticipant>): List<BridgeParticipant> {
            var total = list.sumOf { it.avatar?.length ?: 0 }
            if (total <= AVATAR_BUDGET_CHARS) return list
            val bySize = list.withIndex()
                .map { it.index to (it.value.avatar?.length ?: 0) }
                .filter { it.second > 0 }
                .sortedWith(compareByDescending<Pair<Int, Int>> { it.second }.thenBy { it.first })
            val dropped = HashSet<Int>()
            for ((index, size) in bySize) {
                if (total <= AVATAR_BUDGET_CHARS) break
                dropped += index
                total -= size
            }
            return list.mapIndexed { i, p -> if (i in dropped) p.copy(avatar = null) else p }
        }

        /** `mapTransportError` of the web host: what the app can act on, and nothing else. */
        fun mapTransportError(code: String, forEnd: Boolean): String = when (code) {
            "not-allowed" -> if (forEnd) "not-host" else "not-allowed"
            "ended" -> "ended"
            "rate-limited" -> "rate-limited"
            "too-large" -> "too-large"
            "stale-rev" -> "stale-rev"
            // `full` and `unavailable`: nothing an app can act on except trying again
            else -> "unavailable"
        }
    }
}

/** Who a user id is, for drawing a seat: a name and a small avatar as a data URL. Never given to the app as a link. */
interface ActivityPeople {
    suspend fun describe(userId: String): Person?

    data class Person(val displayName: String, val avatarDataUrl: String?)
}
