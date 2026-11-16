package gg.pqp.app.activities

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull

/*
 * Activities are what happens inside a channel: the apps platform of
 * `docs/APPS.md` (flag `apps`, per server) as a phone sees it. The wire shapes
 * here are the ones in `packages/shared/src/apps/` (`config.ts`, `frames.ts`,
 * `message.ts`); every one is server to client, so unknown keys are ignored
 * and anything a newer server adds is dropped, never an error.
 *
 * "Activity" is the product word; the platform, the server and the web client
 * all say "app". The code keeps the wire's word where it is a field name.
 */

/** `GET /api/apps/config?serverId=`. Off, and an older server, read as `enabled = false`. */
@Serializable
data class ActivitiesConfig(
    val enabled: Boolean = false,
    /** The apps origin (`APPS_ORIGIN`); null means no app can run on this deployment. */
    val origin: String? = null,
    val apps: List<ActivityApp> = emptyList(),
) {
    companion object {
        val Off = ActivitiesConfig()
    }
}

@Serializable
data class ActivityApp(
    val id: String,
    val version: String,
    val category: String = "tool",
    val icon: String = "sparkles",
    /** i18n keys, resolved through [i18n]; [textFor] is the one reader. */
    val name: String = "",
    val description: String = "",
    val notice: String? = null,
    val presence: ActivityPresenceKeys = ActivityPresenceKeys(),
    val channelTypes: List<String> = emptyList(),
    val players: ActivityPlayers = ActivityPlayers(),
    val requires: ActivityRequires = ActivityRequires(),
    val state: ActivityStateCaps? = null,
    val events: ActivityEventCaps? = null,
    val capabilities: ActivityCapabilities = ActivityCapabilities(),
    val i18n: Map<String, Map<String, String>> = emptyMap(),
    val entry: ActivityEntry = ActivityEntry(),
    val available: Boolean = false,
    /** Null when [available]; otherwise the first gate that failed (`APP_UNAVAILABLE_REASONS`). */
    val reason: String? = null,
    val shareAllowed: Boolean = false,
    val saveSync: Boolean = false,
) {
    /** The app's own words in [locale], then English, then Brazilian Portuguese, then the key. */
    fun textFor(key: String, locale: String): String {
        val lang = locale.substringBefore('-').lowercase()
        val order = buildList {
            if (locale.equals("pt-BR", ignoreCase = true) || lang == "pt") add("pt-BR")
            if (lang == "es") add("es")
            add("en")
            add("pt-BR")
        }
        for (tag in order) i18n[tag]?.get(key)?.let { return it }
        return key
    }

    fun displayName(locale: String): String = textFor(name, locale)
    fun displayDescription(locale: String): String = textFor(description, locale)
}

@Serializable
data class ActivityPresenceKeys(val phrase: String = "", val short: String = "")

@Serializable
data class ActivityPlayers(
    val min: Int = 1,
    val max: Int = 1,
    val spectators: Boolean = false,
    val maxSpectators: Int = 50,
)

@Serializable
data class ActivityRequires(val start: String = "USE_APPS", val join: String = "VIEW_CHANNEL")

@Serializable
data class ActivityStateCaps(
    val maxBytes: Int = 0,
    val maxWritesPerSecond: Int? = null,
    val writers: String = "participants",
)

@Serializable
data class ActivityEventCaps(val maxPerSecond: Int = 0, val maxBytes: Int = 0)

@Serializable
data class ActivityCapabilities(
    val identity: String = "display",
    val share: String = "none",
    val localFiles: ActivityToggle = ActivityToggle(),
    val deviceStore: ActivityToggle? = null,
)

@Serializable
data class ActivityToggle(val allowed: Boolean = false)

@Serializable
data class ActivityEntry(val url: String? = null)

/** `POST /api/channels/:id/app-sessions` answers the summary itself; the list read wraps each in [ChannelSession]. */
@Serializable
data class ChannelSessionsResponse(val sessions: List<ChannelSession> = emptyList())

@Serializable
data class ChannelSession(val channelId: String, val session: ActivitySession? = null)

/**
 * `appSessionSummarySchema`: what everyone who can view the channel knows about
 * its live session. No state and no seat ids. Never carries a name or a face:
 * who the user ids are comes from the server's member list.
 */
@Serializable
data class ActivitySession(
    val id: String,
    val appId: String,
    val appVersion: String = "",
    val startedBy: String? = null,
    val hostUserId: String? = null,
    val startedAt: String = "",
    val participants: List<ActivitySessionParticipant> = emptyList(),
    val players: Int = 0,
    val spectators: Int = 0,
    val handoff: ActivityHandoff? = null,
) {
    fun isSeated(userId: String?): Boolean = userId != null && participants.any { it.userId == userId }

    /** The people holding a seat now: a player or spectator whose socket is up or held for its resume window. */
    val total: Int get() = players + spectators
}

@Serializable
data class ActivitySessionParticipant(
    val userId: String,
    val role: String = "player",
    val joinedAt: String = "",
    val connection: String = "present",
)

@Serializable
data class ActivityHandoff(val toUserId: String? = null, val at: String = "")

/** The `GET /api/me/app-consents` rows this client reads. */
@Serializable
data class ActivityConsentsResponse(val consents: List<ActivityConsent> = emptyList())

@Serializable
data class ActivityConsent(
    val appId: String,
    val acceptedVersion: String = "",
    val identityGranted: Boolean = false,
    val stale: Boolean = false,
)

@Serializable
data class StartActivityRequest(val appId: String)

@Serializable
data class ConsentRequest(val identityGranted: Boolean? = null)

@Serializable
data class EndActivityResponse(val ended: Boolean = false)

/** Why a session ended (`APP_END_REASONS`); anything a newer server adds reads as [Other]. */
enum class ActivityEndReason(val wire: String) {
    Host("host"),
    Moderator("moderator"),
    Operator("operator"),
    Idle("idle"),
    HostGone("host-gone"),
    AppDisabled("app-disabled"),
    Empty("empty"),
    MaxDuration("max-duration"),
    ChannelGone("channel-gone"),
    FlagOff("flag-off"),
    Other("other"),
    ;

    companion object {
        fun of(wire: String?): ActivityEndReason = entries.firstOrNull { it.wire == wire } ?: Other
    }
}

/**
 * A JSON value off the bridge or a frame, kept as the library's own type. The
 * alias exists so the bridge code reads like the contract (`JsonValue`) and so
 * a null is spelled one way.
 */
typealias JsonValue = JsonElement

internal val JsonNullValue: JsonValue = JsonNull
