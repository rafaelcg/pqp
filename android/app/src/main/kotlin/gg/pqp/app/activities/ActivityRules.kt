package gg.pqp.app.activities

import gg.pqp.app.core.Permission
import gg.pqp.app.core.hasPermission

/*
 * The decisions the activity screens make, from data alone and with no Android
 * in them, so a JVM test can hold each one (`ActivityRulesTest`): which tiles
 * the picker lists and why one cannot start, what the strip says about a live
 * session for the person looking at it, and how a refusal reads. The web
 * equivalents are `launcher-model.ts`, `strip-model.ts` and `join-model.ts`.
 */

/** Why an activity cannot start in this channel, in the order a person would meet the reasons. */
enum class TileReason {
    /** The app is for the other kind of channel. */
    VoiceOnly,
    TextOnly,

    /** Off on this server (the flag, the operator's release, the owner's switch, the apps origin). */
    OffHere,

    /** A public community, where the app has no safety decision yet. */
    Community,

    /** Not live right now, or no origin to run from. */
    Unavailable,

    /** The manifest asks for MANAGE_CHANNELS of whoever starts it. */
    NeedsManage,

    /** This person may not start activities in this channel (USE_APPS). */
    NoPermission,
}

/** One channel row's mark for a live activity. */
data class ActivityRowSummary(val appName: String, val inside: Int)

data class ActivityTile(
    val app: ActivityApp,
    /** Null when it can start here. */
    val reason: TileReason?,
    /** This is the activity running in the channel right now. */
    val running: Boolean,
) {
    val id: String get() = app.id
}

object ActivityRules {
    /**
     * `text` or `voice`, the only two kinds an app can run in (`channelTypes` of the
     * manifest); null for a forum, a jam, a watch party or a category, where the
     * server answers `channel-type` and the phone draws no launcher at all.
     */
    fun channelKind(type: String): String? = type.takeIf { it == "text" || it == "voice" }

    /**
     * One tile per app the server listed, dimmed with its reason written when it
     * cannot start here, never hidden: a person learns that it exists and where it works.
     */
    fun tiles(
        config: ActivitiesConfig,
        channelType: String,
        live: ActivitySession?,
        canUseApps: Boolean,
        canManageChannels: Boolean,
    ): List<ActivityTile> {
        val kind = channelKind(channelType) ?: return emptyList()
        return config.apps.map { app ->
            ActivityTile(
                app = app,
                reason = tileReason(app, kind, canUseApps, canManageChannels),
                running = live?.appId == app.id,
            )
        }
    }

    fun tileReason(app: ActivityApp, kind: String, canUseApps: Boolean, canManageChannels: Boolean): TileReason? {
        if (kind !in app.channelTypes) return if (kind == "text") TileReason.VoiceOnly else TileReason.TextOnly
        if (!app.available) return reasonOf(app.reason)
        if (!canUseApps) return TileReason.NoPermission
        if (app.requires.start == "MANAGE_CHANNELS" && !canManageChannels) return TileReason.NeedsManage
        return null
    }

    private fun reasonOf(reason: String?): TileReason = when (reason) {
        "community-locked" -> TileReason.Community
        "no-origin", "not-live" -> TileReason.Unavailable
        else -> TileReason.OffHere
    }

    /**
     * What a channel row says when an activity is running in it: the app's name, and how many are
     * inside (the screen reader's sentence). Only while the server's config says activities are on,
     * and only for the channels the list is drawing, so a session in a channel this person cannot
     * see (the store only ever holds the ones they can) or on another server marks nothing.
     */
    fun rowSummaries(
        config: ActivitiesConfig,
        sessions: Map<String, ActivitySession>,
        channelIds: List<String>,
        locale: String,
    ): Map<String, ActivityRowSummary> {
        if (!config.enabled) return emptyMap()
        val out = LinkedHashMap<String, ActivityRowSummary>()
        for (channelId in channelIds) {
            val live = sessions[channelId] ?: continue
            val name = config.apps.firstOrNull { it.id == live.appId }?.displayName(locale) ?: live.appId
            out[channelId] = ActivityRowSummary(name, live.total)
        }
        return out
    }

    /** USE_APPS in this channel (channel overwrites included: the snapshot's bits for it are already resolved). */
    fun mayUseApps(channelBits: Long): Boolean = hasPermission(channelBits, Permission.USE_APPS)

    fun mayManageChannels(channelBits: Long): Boolean = hasPermission(channelBits, Permission.MANAGE_CHANNELS)

    /**
     * Whether the launcher is worth drawing at all for this server: apps are on
     * and at least one is released. With none released, only whoever may manage
     * the server would learn anything from an empty panel, and a phone has no
     * place to act on it, so nothing is drawn.
     */
    fun launcherVisible(config: ActivitiesConfig, channelType: String): Boolean {
        if (!config.enabled || config.origin == null) return false
        val kind = channelKind(channelType) ?: return false
        return config.apps.any { kind in it.channelTypes && it.available }
    }

    /** The tile that starts selected: the one already running here, else the first that can start. */
    fun initialSelection(tiles: List<ActivityTile>): String? =
        (tiles.firstOrNull { it.running } ?: tiles.firstOrNull { it.reason == null } ?: tiles.firstOrNull())?.id

    // --- what the strip says about a live session ---

    /** The face of the strip for the person looking at it. */
    sealed interface StripFace {
        /** A session is live and this person is not in it: [full] turns Entrar into Assistir. */
        data class Open(val full: Boolean, val canWatch: Boolean) : StripFace

        /** In it as a player or a spectator. */
        data class Inside(val spectator: Boolean, val host: Boolean, val reconnecting: Boolean) : StripFace
    }

    fun stripFace(session: ActivitySession, app: ActivityApp?, viewerId: String?): StripFace {
        val mine = session.participants.firstOrNull { it.userId == viewerId }
        if (mine != null) {
            return StripFace.Inside(
                spectator = mine.role == "spectator",
                host = session.hostUserId == viewerId,
                reconnecting = mine.connection == "reconnecting",
            )
        }
        val full = app != null && session.players >= app.players.max
        return StripFace.Open(full = full, canWatch = app != null && canWatch(app))
    }

    /** What the strip's one button does for this person. */
    enum class StripAction { Join, Watch, Back, Full, ComputerOnly, None }

    /**
     * Join where a phone can play, Watch where it can only look (an emulator, or a room that filled),
     * Back for somebody already inside. An app the config does not list (released and then turned
     * off while the session ran) has no way in, so no button.
     */
    fun stripAction(app: ActivityApp?, face: StripFace): StripAction = when {
        face is StripFace.Inside -> StripAction.Back
        app == null -> StripAction.None
        !phoneMayPlay(app) -> if (canWatch(app)) StripAction.Watch else StripAction.ComputerOnly
        face is StripFace.Open && face.full -> if (face.canWatch) StripAction.Watch else StripAction.Full
        else -> StripAction.Join
    }

    /**
     * Whether Assistir is on offer (D14 included: `shareAllowed` is the emulator
     * gate, so an emulator app admits spectators only where `locadora_share` is on).
     */
    fun canWatch(app: ActivityApp): Boolean = app.players.spectators && app.shareAllowed

    /**
     * What a phone can do inside an app, from the manifest: take part (the bundle
     * runs in the web view and speaks the same bridge) or only watch. Locadora is
     * an emulator whose controls are a keyboard and a gamepad, which a touchscreen
     * does not have yet, so there a phone spectates; any other app is a full seat.
     */
    fun phoneMayPlay(app: ActivityApp): Boolean = app.category != "emulator"

    /** What to ask the server for when somebody taps Entrar: a seat as a player, or as a spectator. */
    fun joinAsSpectator(app: ActivityApp, session: ActivitySession, viewerId: String?, chosenToWatch: Boolean): Boolean {
        if (!phoneMayPlay(app)) return true
        if (chosenToWatch) return true
        // The room filled: the server would seat a spillover as a spectator anyway, so ask for it.
        return session.players >= app.players.max && viewerId !in session.participants.map { it.userId } && canWatch(app)
    }

    /** The first sentence a failed start gets. */
    enum class StartFailure { SessionLive, CannotStart, Unavailable, RateLimited, Failed }

    fun failureOf(refusal: StartRefusal): StartFailure = when (refusal) {
        is StartRefusal.AlreadyLive -> StartFailure.SessionLive
        StartRefusal.CannotStart -> StartFailure.CannotStart
        is StartRefusal.Unavailable -> StartFailure.Unavailable
        StartRefusal.RateLimited -> StartFailure.RateLimited
        is StartRefusal.Failed -> StartFailure.Failed
    }

    /** A first name for "started by": the member's nickname, then display name; null when the list has not got them. */
    fun nameOf(member: gg.pqp.app.core.ServerMember?): String? =
        member?.let { (it.nickname?.takeIf { n -> n.isNotBlank() } ?: it.displayName).takeIf { n -> n.isNotBlank() } }
}
