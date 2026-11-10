import Foundation

// What the phone shows about activities, decided from data alone so a table of
// inputs pins every state (the web's `launcher-model.ts` / `strip-model.ts`,
// narrowed to what a phone does).

// MARK: - What a phone can do with an app

/// How far a phone goes with an app. The server's config does not say which
/// apps are phone-ready (the manifest's `platforms` is not on the wire), so
/// this build keeps its own short list, written down on purpose: an app is
/// offered as playable only after somebody has run it on a phone.
enum AppPhoneSupport: Equatable, Sendable {
    /// Joins as a player and runs in the sandboxed frame.
    case participate
    /// Seated as a spectator only: the app's picture is a share in the call.
    case spectate
    /// Nothing yet: the tile says so and offers nothing to tap.
    case none

    /// Apps this build has run on a phone and found usable with a finger.
    static let participating: Set<String> = [AppIds.eco]
    /// Apps this build seats a phone in as a spectator only. Locadora runs an
    /// emulator on the player's computer; a phone watches the picture the host
    /// shares into the call (and the platform admits spectators to it only where
    /// `locadora_share` is on, D14).
    static let spectating: Set<String> = [AppIds.locadora]

    static func of(_ app: AppEntry) -> AppPhoneSupport {
        if participating.contains(app.id) { return .participate }
        if spectating.contains(app.id), app.players.spectators, app.shareAllowed { return .spectate }
        return .none
    }
}

enum AppIds {
    static let eco = "pqp-eco"
    static let locadora = "pqp-locadora"
}

/// The pqp icon ids an app may name (`APP_ICON_IDS`), as SF Symbols. One the
/// build does not know draws the generic glyph, never a hole.
enum AppIcon {
    static func symbol(_ id: String) -> String {
        switch id {
        case "gamepad": "gamecontroller.fill"
        case "poll": "chart.bar.fill"
        case "pencil": "pencil.tip"
        case "music": "music.note"
        case "dice": "dice.fill"
        case "cards": "suit.spade.fill"
        case "puzzle": "puzzlepiece.fill"
        case "trophy": "trophy.fill"
        case "sparkles": "sparkles"
        case "flask": "flask.fill"
        default: "square.grid.2x2.fill"
        }
    }
}

// MARK: - The launcher

enum LauncherChannelType: String, Sendable { case text, voice }

/// Why a tile cannot start here, in the order a person would meet the reasons.
enum LauncherReason: Equatable, Sendable {
    case voiceOnly, textOnly
    /// Off on this server, or not released here.
    case off
    case community
    case unavailable
    case needsManage
    /// The app exists but this phone cannot run it yet.
    case onComputer
    /// This phone can only watch it, so it cannot start one.
    case watchOnly
    /// Another activity already runs in this channel (one per channel).
    case otherRunning
}

struct LauncherTile: Identifiable, Equatable, Sendable {
    var id: String { app.id }
    let app: AppEntry
    let support: AppPhoneSupport
    /// Nil means "Começar" is available.
    let reason: LauncherReason?
    /// This is the app running in the channel right now.
    let running: Bool
}

enum LauncherRules {
    /// The first reason an app cannot start in this channel, or nil.
    static func reason(
        for app: AppEntry, channelType: LauncherChannelType, canManageChannels: Bool,
        runningHere: AppSessionSummary?
    ) -> LauncherReason? {
        if !app.channelTypes.contains(channelType.rawValue) {
            return channelType == .text ? .voiceOnly : .textOnly
        }
        if !app.available {
            switch app.reason {
            case .communityLocked?: return .community
            case .noOrigin?, .notLive?: return .unavailable
            default: return .off
            }
        }
        switch AppPhoneSupport.of(app) {
        case .none: return .onComputer
        case .spectate: return .watchOnly
        case .participate: break
        }
        if app.requires.start == "MANAGE_CHANNELS", !canManageChannels { return .needsManage }
        if let runningHere, runningHere.appId != app.id { return .otherRunning }
        return nil
    }

    static func tiles(
        config: AppsConfig, channelType: LauncherChannelType, canManageChannels: Bool,
        live: AppSessionSummary?
    ) -> [LauncherTile] {
        config.apps.map { app in
            LauncherTile(
                app: app,
                support: AppPhoneSupport.of(app),
                reason: reason(for: app, channelType: channelType, canManageChannels: canManageChannels, runningHere: live),
                running: live?.appId == app.id
            )
        }
    }

    /// The tile that starts selected: the app running here, else the first that
    /// can start, else the first of the list.
    static func initialSelection(_ tiles: [LauncherTile]) -> String? {
        (tiles.first(where: \.running) ?? tiles.first(where: { $0.reason == nil }) ?? tiles.first)?.id
    }

    /// Whether the phone offers the entry at all. With the platform off, or with
    /// nothing a phone can show or start, nothing appears: a server without the
    /// feature must look exactly as it did before it existed.
    static func offersEntry(config: AppsConfig?, live: AppSessionSummary?) -> Bool {
        guard let config, config.enabled, config.origin != nil else { return false }
        if live != nil { return true }
        return config.apps.contains { AppPhoneSupport.of($0) != .none }
    }
}

// MARK: - The strip

enum StripPhase: Equatable, Sendable {
    case host, participant, spectator
    case handoffYou, handoffOther
    case reconnecting, lost
    case outside
}

enum StripEnter: Equatable, Sendable {
    case join
    /// Seated as a spectator because the room is full.
    case watch
    /// The picture is the host's share in the channel's call: this phone watches
    /// it there, with no seat in the app (an emulator runs on the player's
    /// computer, and the platform admits a spectator only where it may share).
    case watchInCall
}

/// What the strip says, from data and nothing else.
struct ActivityStripModel: Equatable, Sendable {
    let sessionId: String
    let appId: String
    let phase: StripPhase
    /// Seated in the session on the server, whatever the role.
    let seated: Bool
    let isHost: Bool
    let players: Int
    let watching: Int
    let maxPlayers: Int
    let hostUserId: String?
    /// What the Entrar button does for this phone, or nil.
    let enter: StripEnter?
    /// The phone cannot run this app at all (nothing to tap but the explanation).
    let support: AppPhoneSupport
    let canEnd: Bool
    /// A voice channel, where a spectate-only app's picture can be watched.
    let channelIsVoice: Bool
    /// Names, in the order of the roster, for the avatars.
    let people: [String]
}

struct StripInput {
    var live: AppSessionSummary
    var app: AppEntry?
    var viewerId: String?
    var online: Bool
    var offlineSince: Date?
    var now: Date
    /// MANAGE_CHANNELS in this channel (or an instance moderator).
    var canModerate: Bool
    /// This phone pressed Sair and the summary has not caught up yet.
    var leftLocally: Bool
    var channelIsVoice: Bool = false
    /// This phone is in this channel's call already: the picture is on that screen.
    var inCallHere: Bool = false
}

enum StripRules {
    static func model(_ input: StripInput) -> ActivityStripModel {
        let live = input.live
        let app = input.app
        let row = live.participant(input.viewerId)
        let offlineTooLong = !input.online
            && (input.offlineSince.map { input.now.timeIntervalSince($0) > AppLimits.resumeWindow } ?? false)
        let seatedByServer = row != nil && !input.leftLocally
        let seated = seatedByServer && !offlineTooLong
        let spectating = row?.role == .spectator
        let isHost = seated && input.viewerId != nil && live.hostUserId == input.viewerId
        let max = app?.players.max ?? Int.max
        let support = app.map(AppPhoneSupport.of) ?? .none

        let phase: StripPhase
        if seatedByServer && offlineTooLong {
            phase = .lost
        } else if seated && (!input.online || row?.connection == .reconnecting) {
            phase = .reconnecting
        } else if let handoff = live.handoff {
            if handoff.toUserId == input.viewerId, seated { phase = .handoffYou }
            else { phase = seated ? .handoffOther : .outside }
        } else if !seated {
            phase = .outside
        } else if isHost {
            phase = .host
        } else if spectating {
            phase = .spectator
        } else {
            phase = .participant
        }

        let full = live.players >= max
        let canWatchWhenFull = app?.players.spectators == true && app?.shareAllowed == true
        let enter: StripEnter?
        switch support {
        case .none:
            enter = nil
        case .spectate:
            enter = input.channelIsVoice && !input.inCallHere ? .watchInCall : nil
        case .participate:
            if seated { enter = nil }
            else if full { enter = canWatchWhenFull ? .watch : nil }
            else { enter = .join }
        }

        return ActivityStripModel(
            sessionId: live.id,
            appId: live.appId,
            phase: phase,
            seated: seated,
            isHost: isHost,
            players: live.players,
            watching: live.spectators,
            maxPlayers: max,
            hostUserId: live.hostUserId,
            enter: enter,
            support: support,
            canEnd: (isHost || input.canModerate) && phase != .lost,
            channelIsVoice: input.channelIsVoice,
            people: []
        )
    }

    /// Seconds left of a handoff, never negative.
    static func secondsUntil(_ date: Date, now: Date) -> Int {
        max(0, Int(ceil(date.timeIntervalSince(now))))
    }
}

// MARK: - What the store remembers of an ending

/// The quiet record of a session that ended while this phone was looking: one
/// line, a cause, and who ended it.
struct EndedActivity: Equatable, Sendable {
    let sessionId: String
    let channelId: String
    let appId: String?
    /// Who was host when it ended, for "Raf encerrou".
    let hostUserId: String?
    let reason: AppEndReason
    let summary: AppEndSummary
    let endedAt: Date
    /// This phone was seated when it ended, so it is told; a viewer who was only
    /// looking at the channel sees the strip simply disappear.
    let wasSeated: Bool
}

enum EndedRules {
    /// How long the "terminou" strip stays before it goes on its own.
    static let lifetime: TimeInterval = 25
}

/// The "N dentro" count line, as parts a view writes.
enum StripCount: Equatable, Sendable {
    case none
    case of(players: Int, max: Int, watching: Int)
    case open(players: Int, watching: Int)

    static let unbounded = 32

    static func of(model: ActivityStripModel) -> StripCount {
        if model.players == 0 && model.watching == 0 { return .none }
        if model.maxPlayers >= unbounded { return .open(players: model.players, watching: model.watching) }
        return .of(players: model.players, max: model.maxPlayers, watching: model.watching)
    }
}
