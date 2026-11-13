import Foundation

// Activities (the web's "apps", docs/APPS.md), as the wire carries them. The
// contract is `packages/shared/src/apps/{config,frames,common}.ts`; Swift cannot
// import it, so this mirrors the parts a phone reads, decoded leniently: a field
// a card can live without is read with a default, so a server that adds one
// costs a detail, not the whole list. Server to client is tolerant of anything
// newer; nothing here is ever sent back as it was received.
//
// WHAT AN ACTIVITY IS, ONCE. A small sandboxed web bundle that somebody starts in
// a text or voice channel and others join. The platform (this app) owns the
// launcher, the live strip, the permissions and the join sheet; the bundle only
// talks to its host through the message bridge (`AppBridge`). One live session
// per channel.

/// The caps this build enforces again on the phone (`limits.ts`, `manifest.ts`).
/// The server enforces them for real; these keep a misbehaving frame from costing
/// a socket frame the server would refuse.
enum AppLimits {
    static let platformApi = 1
    static let stateMaxBytes = 16384
    static let eventMaxBytes = 1024
    static let eventMaxPerSecond = 20
    static let stateMaxWritesPerSecond = 10
    static let jsonMaxDepth = 32
    static let maxParticipants = 264
    static let avatarMaxChars = 65536
    static let avatarsBudgetChars = 4 * 1024 * 1024
    static let displayNameMaxChars = 64
    static let themeMaxTokens = 64
    static let uiMinHeight = 120
    static let uiMaxHeight = 2000
    /// A held seat is kept this long after the socket drops (`APP_RESUME_WINDOW_MS`).
    static let resumeWindow: TimeInterval = 90
    /// How long a join may take before the phone calls it a failure.
    static let joinTimeout: TimeInterval = 8
}

/// Why an app cannot run in a place, most fundamental first (`appUnavailableReasonSchema`).
enum AppUnavailableReason: String, Hashable, Sendable {
    case flagOff = "flag-off"
    case notLive = "not-live"
    case globalOff = "global-off"
    case notAllowedHere = "not-allowed-here"
    case ownerOff = "owner-off"
    case communityLocked = "community-locked"
    case emulatorOff = "emulator-off"
    case channelType = "channel-type"
    case noOrigin = "no-origin"
    /// A reason a newer server invented: read as "not available", never as a crash.
    case other
}

struct AppPlayers: Decodable, Hashable, Sendable {
    let min: Int
    let max: Int
    let spectators: Bool
    let maxSpectators: Int

    init(min: Int = 1, max: Int = 8, spectators: Bool = false, maxSpectators: Int = 50) {
        self.min = min
        self.max = max
        self.spectators = spectators
        self.maxSpectators = maxSpectators
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        min = try c.decodeIfPresent(Int.self, forKey: .min) ?? 1
        max = try c.decodeIfPresent(Int.self, forKey: .max) ?? 8
        spectators = try c.decodeIfPresent(Bool.self, forKey: .spectators) ?? false
        maxSpectators = try c.decodeIfPresent(Int.self, forKey: .maxSpectators) ?? 50
    }

    private enum CodingKeys: String, CodingKey { case min, max, spectators, maxSpectators }
}

struct AppRequires: Decodable, Hashable, Sendable {
    /// `USE_APPS` or `MANAGE_CHANNELS`.
    let start: String
    /// `VIEW_CHANNEL` or `CONNECT`.
    let join: String

    init(start: String = "USE_APPS", join: String = "VIEW_CHANNEL") {
        self.start = start
        self.join = join
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        start = try c.decodeIfPresent(String.self, forKey: .start) ?? "USE_APPS"
        join = try c.decodeIfPresent(String.self, forKey: .join) ?? "VIEW_CHANNEL"
    }

    private enum CodingKeys: String, CodingKey { case start, join }
}

/// The caps of the shared session state a manifest sets (`state` in the config).
struct AppStateCaps: Decodable, Hashable, Sendable {
    let maxBytes: Int
    let maxWritesPerSecond: Int
    /// `host` or `participants`.
    let writers: String

    init(maxBytes: Int = AppLimits.stateMaxBytes, maxWritesPerSecond: Int = AppLimits.stateMaxWritesPerSecond, writers: String = "participants") {
        self.maxBytes = maxBytes
        self.maxWritesPerSecond = maxWritesPerSecond
        self.writers = writers
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        maxBytes = try c.decodeIfPresent(Int.self, forKey: .maxBytes) ?? AppLimits.stateMaxBytes
        maxWritesPerSecond = try c.decodeIfPresent(Int.self, forKey: .maxWritesPerSecond)
            ?? AppLimits.stateMaxWritesPerSecond
        writers = try c.decodeIfPresent(String.self, forKey: .writers) ?? "participants"
    }

    private enum CodingKeys: String, CodingKey { case maxBytes, maxWritesPerSecond, writers }
}

struct AppEventCaps: Decodable, Hashable, Sendable {
    let maxPerSecond: Int
    let maxBytes: Int

    init(maxPerSecond: Int = AppLimits.eventMaxPerSecond, maxBytes: Int = AppLimits.eventMaxBytes) {
        self.maxPerSecond = maxPerSecond
        self.maxBytes = maxBytes
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        maxPerSecond = try c.decodeIfPresent(Int.self, forKey: .maxPerSecond) ?? AppLimits.eventMaxPerSecond
        maxBytes = try c.decodeIfPresent(Int.self, forKey: .maxBytes) ?? AppLimits.eventMaxBytes
    }

    private enum CodingKeys: String, CodingKey { case maxPerSecond, maxBytes }
}

/// The slice of the manifest's `capabilities` the join sheet and the host read.
struct AppCapabilities: Decodable, Hashable, Sendable {
    /// `display` or `user-id`.
    let identity: String
    /// `none` or `pane`.
    let share: String
    let localFilesAllowed: Bool
    let deviceStoreAllowed: Bool

    init(identity: String = "display", share: String = "none", localFilesAllowed: Bool = false, deviceStoreAllowed: Bool = false) {
        self.identity = identity
        self.share = share
        self.localFilesAllowed = localFilesAllowed
        self.deviceStoreAllowed = deviceStoreAllowed
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        identity = try c.decodeIfPresent(String.self, forKey: .identity) ?? "display"
        share = try c.decodeIfPresent(String.self, forKey: .share) ?? "none"
        localFilesAllowed = (try? c.decode(Allowed.self, forKey: .localFiles))?.allowed ?? false
        deviceStoreAllowed = (try? c.decode(Allowed.self, forKey: .deviceStore))?.allowed ?? false
    }

    private struct Allowed: Decodable { let allowed: Bool }
    private enum CodingKeys: String, CodingKey { case identity, share, localFiles, deviceStore }
}

/// One app of `GET /api/apps/config?serverId=`, as the launcher and the runtime
/// see it. `name` and `description` are i18n KEYS; the words are in `i18n`.
struct AppEntry: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let version: String
    /// `game`, `tool` or `emulator`.
    let category: String
    /// An id of the pqp icon set; this build maps the ones it knows to SF Symbols.
    let icon: String
    let nameKey: String
    let descriptionKey: String
    let presencePhraseKey: String
    let presenceShortKey: String
    /// `text`, `voice`, or both.
    let channelTypes: [String]
    let players: AppPlayers
    let requires: AppRequires
    let state: AppStateCaps
    let events: AppEventCaps
    let capabilities: AppCapabilities
    let hostBound: Bool
    let i18n: [String: [String: String]]
    /// Where the bundle's entry page is, on the apps origin. Nil while there is none.
    let entryURL: String?
    let available: Bool
    let reason: AppUnavailableReason?
    let shareAllowed: Bool

    private enum CodingKeys: String, CodingKey {
        case id, version, category, icon, name, description, presence, channelTypes
        case players, requires, state, events, capabilities, hostBound, i18n, entry
        case available, reason, shareAllowed
    }

    private struct Presence: Decodable { let phrase: String?; let short: String? }
    private struct Entry: Decodable { let url: String? }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        version = try c.decodeIfPresent(String.self, forKey: .version) ?? ""
        category = try c.decodeIfPresent(String.self, forKey: .category) ?? "tool"
        icon = try c.decodeIfPresent(String.self, forKey: .icon) ?? "sparkles"
        nameKey = try c.decodeIfPresent(String.self, forKey: .name) ?? "name"
        descriptionKey = try c.decodeIfPresent(String.self, forKey: .description) ?? "description"
        let presence = try? c.decodeIfPresent(Presence.self, forKey: .presence)
        presencePhraseKey = presence?.phrase ?? "presence.phrase"
        presenceShortKey = presence?.short ?? "presence.short"
        channelTypes = try c.decodeIfPresent([String].self, forKey: .channelTypes) ?? []
        players = (try? c.decodeIfPresent(AppPlayers.self, forKey: .players)) ?? AppPlayers()
        requires = (try? c.decodeIfPresent(AppRequires.self, forKey: .requires)) ?? AppRequires()
        state = (try? c.decodeIfPresent(AppStateCaps.self, forKey: .state)) ?? AppStateCaps()
        events = (try? c.decodeIfPresent(AppEventCaps.self, forKey: .events)) ?? AppEventCaps()
        capabilities = (try? c.decodeIfPresent(AppCapabilities.self, forKey: .capabilities)) ?? AppCapabilities()
        hostBound = try c.decodeIfPresent(Bool.self, forKey: .hostBound) ?? false
        i18n = try c.decodeIfPresent([String: [String: String]].self, forKey: .i18n) ?? [:]
        entryURL = (try? c.decodeIfPresent(Entry.self, forKey: .entry))?.url
        available = try c.decodeIfPresent(Bool.self, forKey: .available) ?? false
        let rawReason = try c.decodeIfPresent(String.self, forKey: .reason)
        reason = rawReason.map { AppUnavailableReason(rawValue: $0) ?? .other }
        shareAllowed = try c.decodeIfPresent(Bool.self, forKey: .shareAllowed) ?? false
    }

    /// For tests and previews.
    init(
        id: String, version: String = "1.0.0", category: String = "tool", icon: String = "sparkles",
        channelTypes: [String] = ["text", "voice"], players: AppPlayers = AppPlayers(spectators: true),
        requires: AppRequires = AppRequires(), state: AppStateCaps = AppStateCaps(),
        events: AppEventCaps = AppEventCaps(), capabilities: AppCapabilities = AppCapabilities(),
        hostBound: Bool = false, i18n: [String: [String: String]] = [:], entryURL: String? = nil,
        available: Bool = true, reason: AppUnavailableReason? = nil, shareAllowed: Bool = false
    ) {
        self.id = id
        self.version = version
        self.category = category
        self.icon = icon
        self.nameKey = "name"
        self.descriptionKey = "description"
        self.presencePhraseKey = "presence.phrase"
        self.presenceShortKey = "presence.short"
        self.channelTypes = channelTypes
        self.players = players
        self.requires = requires
        self.state = state
        self.events = events
        self.capabilities = capabilities
        self.hostBound = hostBound
        self.i18n = i18n
        self.entryURL = entryURL
        self.available = available
        self.reason = reason
        self.shareAllowed = shareAllowed
    }

    // MARK: Words

    /// The app's own string for `key` in the reader's language: exact locale,
    /// then the language's base, then English, then the key (`appText` on the web).
    func text(_ key: String, locale: String = AppLocale.current) -> String {
        let resolved = AppLocale.resolve(locale)
        return i18n[resolved]?[key] ?? i18n["en"]?[key] ?? key
    }

    func name(locale: String = AppLocale.current) -> String { text(nameKey, locale: locale) }
    func summary(locale: String = AppLocale.current) -> String { text(descriptionKey, locale: locale) }
    /// "Raf tá no Eco": the phrase with one `{name}`, for where it stands alone.
    func presencePhrase(locale: String = AppLocale.current) -> String { text(presencePhraseKey, locale: locale) }
    /// "No Eco": under a name that is already on screen.
    func presenceShort(locale: String = AppLocale.current) -> String { text(presenceShortKey, locale: locale) }
}

/// The language a manifest string is read in. A manifest carries `pt-BR`, `en`
/// and `es`; anything else reads as English (`resolveAppLocale`).
enum AppLocale {
    static func resolve(_ tag: String) -> String {
        let lower = tag.lowercased().replacingOccurrences(of: "_", with: "-")
        if lower == "pt" || lower.hasPrefix("pt-") { return "pt-BR" }
        if lower == "es" || lower.hasPrefix("es-") { return "es" }
        return "en"
    }

    /// The language this app is showing: the best match among the localisations
    /// the bundle carries (`pt-BR`, `en`), which is what the rest of the app's
    /// copy follows too.
    static var current: String {
        Bundle.main.preferredLocalizations.first ?? "en"
    }
}

/// `GET /api/apps/config?serverId=`.
struct AppsConfig: Decodable, Equatable, Sendable {
    let enabled: Bool
    /// The apps origin, or nil when this deployment cannot run apps.
    let origin: String?
    let apps: [AppEntry]

    static let off = AppsConfig(enabled: false, origin: nil, apps: [])

    init(enabled: Bool, origin: String?, apps: [AppEntry]) {
        self.enabled = enabled
        self.origin = origin
        self.apps = apps
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? false
        origin = try c.decodeIfPresent(String.self, forKey: .origin)
        // One entry this build cannot read must not take the others with it.
        apps = (try c.decodeIfPresent([Lossy<AppEntry>].self, forKey: .apps) ?? []).compactMap(\.value)
    }

    static func == (a: AppsConfig, b: AppsConfig) -> Bool {
        a.enabled == b.enabled && a.origin == b.origin && a.apps == b.apps
    }

    private enum CodingKeys: String, CodingKey { case enabled, origin, apps }
}

// MARK: - Sessions

enum AppRole: String, Hashable, Sendable {
    case player, spectator
}

enum AppConnection: String, Hashable, Sendable {
    case present, reconnecting
}

/// One person in a session as everyone who can view the channel may know it:
/// no seat id, no state (`appSessionSummaryParticipantSchema`).
struct AppSummaryParticipant: Decodable, Hashable, Sendable {
    let userId: String
    let role: AppRole
    let joinedAt: Date?
    let connection: AppConnection

    private enum CodingKeys: String, CodingKey { case userId, role, joinedAt, connection }

    init(userId: String, role: AppRole = .player, joinedAt: Date? = nil, connection: AppConnection = .present) {
        self.userId = userId
        self.role = role
        self.joinedAt = joinedAt
        self.connection = connection
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        userId = try c.decode(String.self, forKey: .userId)
        role = AppRole(rawValue: try c.decodeIfPresent(String.self, forKey: .role) ?? "") ?? .player
        joinedAt = try? c.decodeIfPresent(Date.self, forKey: .joinedAt)
        connection = AppConnection(rawValue: try c.decodeIfPresent(String.self, forKey: .connection) ?? "") ?? .present
    }
}

/// A host handoff counting down: the host left and `toUserId` (or nobody) takes
/// over at `at`.
struct AppHandoff: Decodable, Hashable, Sendable {
    let toUserId: String?
    let at: Date
}

/// What the whole channel knows about its live session (`AppSessionSummary`):
/// enough for the strip and the presence line.
struct AppSessionSummary: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let appId: String
    let appVersion: String
    let startedBy: String?
    let hostUserId: String?
    let startedAt: Date?
    var participants: [AppSummaryParticipant]
    var players: Int
    var spectators: Int
    var handoff: AppHandoff?

    private enum CodingKeys: String, CodingKey {
        case id, appId, appVersion, startedBy, hostUserId, startedAt, participants, players, spectators, handoff
    }

    init(
        id: String, appId: String, appVersion: String = "1.0.0", startedBy: String? = nil,
        hostUserId: String? = nil, startedAt: Date? = nil, participants: [AppSummaryParticipant] = [],
        players: Int? = nil, spectators: Int? = nil, handoff: AppHandoff? = nil
    ) {
        self.id = id
        self.appId = appId
        self.appVersion = appVersion
        self.startedBy = startedBy
        self.hostUserId = hostUserId
        self.startedAt = startedAt
        self.participants = participants
        self.players = players ?? participants.filter { $0.role == .player }.count
        self.spectators = spectators ?? participants.filter { $0.role == .spectator }.count
        self.handoff = handoff
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        appId = try c.decode(String.self, forKey: .appId)
        appVersion = try c.decodeIfPresent(String.self, forKey: .appVersion) ?? ""
        startedBy = try c.decodeIfPresent(String.self, forKey: .startedBy)
        hostUserId = try c.decodeIfPresent(String.self, forKey: .hostUserId)
        startedAt = try? c.decodeIfPresent(Date.self, forKey: .startedAt)
        participants = (try c.decodeIfPresent([Lossy<AppSummaryParticipant>].self, forKey: .participants) ?? [])
            .compactMap(\.value)
        players = try c.decodeIfPresent(Int.self, forKey: .players) ?? 0
        spectators = try c.decodeIfPresent(Int.self, forKey: .spectators) ?? 0
        handoff = try? c.decodeIfPresent(AppHandoff.self, forKey: .handoff)
    }

    /// Whether this person holds a seat in it, whatever the role.
    func isSeated(_ userId: String?) -> Bool {
        guard let userId else { return false }
        return participants.contains { $0.userId == userId }
    }

    func participant(_ userId: String?) -> AppSummaryParticipant? {
        guard let userId else { return nil }
        return participants.first { $0.userId == userId }
    }
}

/// One person in a session as its participants see it (`appSessionParticipantSchema`).
struct AppSeatParticipant: Decodable, Hashable, Sendable {
    let seatId: String
    let userId: String
    let role: AppRole
    let isHost: Bool
    let connection: AppConnection
    let appUserId: String?

    private enum CodingKeys: String, CodingKey { case seatId, userId, role, isHost, connection, appUserId }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        seatId = try c.decode(String.self, forKey: .seatId)
        userId = try c.decode(String.self, forKey: .userId)
        role = AppRole(rawValue: try c.decodeIfPresent(String.self, forKey: .role) ?? "") ?? .player
        isHost = try c.decodeIfPresent(Bool.self, forKey: .isHost) ?? false
        connection = AppConnection(rawValue: try c.decodeIfPresent(String.self, forKey: .connection) ?? "") ?? .present
        appUserId = try c.decodeIfPresent(String.self, forKey: .appUserId)
    }
}

/// The `app-session` snapshot: what a participant gets when it joins or resumes.
struct AppSeatSnapshot: Decodable, Hashable, Sendable {
    let sessionId: String
    let seatId: String
    let role: AppRole
    let isHost: Bool
    let stateRev: Int
    let stateValue: JSONValue
    let participants: [AppSeatParticipant]

    private enum CodingKeys: String, CodingKey { case sessionId, seatId, role, isHost, state, participants }
    private struct StateBody: Decodable { let rev: Int; let value: JSONValue }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = try c.decode(String.self, forKey: .sessionId)
        seatId = try c.decode(String.self, forKey: .seatId)
        role = AppRole(rawValue: try c.decodeIfPresent(String.self, forKey: .role) ?? "") ?? .player
        isHost = try c.decodeIfPresent(Bool.self, forKey: .isHost) ?? false
        let state = try c.decode(StateBody.self, forKey: .state)
        stateRev = state.rev
        stateValue = state.value
        participants = (try c.decodeIfPresent([Lossy<AppSeatParticipant>].self, forKey: .participants) ?? [])
            .compactMap(\.value)
    }

    init(
        sessionId: String, seatId: String, role: AppRole = .player, isHost: Bool = false,
        stateRev: Int = 0, stateValue: JSONValue = .null, participants: [AppSeatParticipant] = []
    ) {
        self.sessionId = sessionId
        self.seatId = seatId
        self.role = role
        self.isHost = isHost
        self.stateRev = stateRev
        self.stateValue = stateValue
        self.participants = participants
    }
}

extension AppSeatParticipant {
    init(seatId: String, userId: String, role: AppRole = .player, isHost: Bool = false,
         connection: AppConnection = .present, appUserId: String? = nil) {
        self.seatId = seatId
        self.userId = userId
        self.role = role
        self.isHost = isHost
        self.connection = connection
        self.appUserId = appUserId
    }
}

/// Why a session ended (`APP_END_REASONS`).
enum AppEndReason: String, Hashable, Sendable {
    case host, moderator, `operator`, idle
    case hostGone = "host-gone"
    case appDisabled = "app-disabled"
    case empty
    case maxDuration = "max-duration"
    case channelGone = "channel-gone"
    case flagOff = "flag-off"
    /// A reason a newer server invented: the plain "it ended".
    case unknown

    init(wire: String?) {
        self = wire.flatMap(AppEndReason.init(rawValue:)) ?? .unknown
    }

    /// The operator switched the app off: its own line on the quiet record.
    var isOperatorSwitch: Bool {
        self == .appDisabled || self == .flagOff || self == .operator
    }
}

enum AppErrorOp: String, Sendable { case join, leave, state, event }

/// The `app-error` codes (`APP_ERROR_CODES`). `unknown` is anything newer.
enum AppErrorCode: String, Hashable, Sendable {
    case full
    case notAllowed = "not-allowed"
    case ended
    case rateLimited = "rate-limited"
    case tooLarge = "too-large"
    case staleRev = "stale-rev"
    case unavailable
    case unknown
}

struct AppEndSummary: Hashable, Equatable, Sendable {
    let participants: Int
    let durationSeconds: Int
    /// `state.result.text` when the app left one: plain text, one line.
    let resultText: String?
}

/// The six frames of the apps wire, after parsing.
enum AppsFrame: Sendable {
    case channelApp(channelId: String, session: AppSessionSummary?)
    case session(AppSeatSnapshot)
    case state(sessionId: String, rev: Int, value: JSONValue)
    case event(sessionId: String, fromSeatId: String, name: String, data: JSONValue)
    case ended(sessionId: String, channelId: String, reason: AppEndReason, summary: AppEndSummary)
    case error(sessionId: String, op: AppErrorOp, code: AppErrorCode)

    static let types: Set<String> = [
        "channel-app", "app-session", "app-state", "app-event", "app-ended", "app-error",
    ]

    private struct Envelope: Decodable {
        let type: String
        let channelId: String?
        let sessionId: String?
        let session: AppSessionSummary?
        let rev: Int?
        let value: JSONValue?
        let fromSeatId: String?
        let name: String?
        let data: JSONValue?
        let reason: String?
        let summary: Summary?
        let op: String?
        let code: String?

        struct Summary: Decodable {
            let participants: Int?
            let durationSeconds: Int?
            let result: JSONValue?
        }
    }

    /// A frame this build cannot read (a missing field, a type it does not know)
    /// is dropped, not guessed at.
    static func parse(_ data: Data) -> AppsFrame? {
        guard let e = try? Coding.decoder.decode(Envelope.self, from: data) else { return nil }
        switch e.type {
        case "channel-app":
            guard let channelId = e.channelId else { return nil }
            // `session: null` means none is live; an unreadable one is dropped
            // rather than read as "ended".
            if let session = e.session { return .channelApp(channelId: channelId, session: session) }
            guard hasNullSession(data) else { return nil }
            return .channelApp(channelId: channelId, session: nil)
        case "app-session":
            return (try? Coding.decoder.decode(AppSeatSnapshot.self, from: data)).map(AppsFrame.session)
        case "app-state":
            guard let id = e.sessionId, let rev = e.rev, let value = e.value else { return nil }
            return .state(sessionId: id, rev: rev, value: value)
        case "app-event":
            guard let id = e.sessionId, let from = e.fromSeatId, let name = e.name else { return nil }
            return .event(sessionId: id, fromSeatId: from, name: name, data: e.data ?? .null)
        case "app-ended":
            guard let id = e.sessionId, let channelId = e.channelId else { return nil }
            let summary = e.summary
            var line: String?
            if case .object(let result)? = summary?.result, case .string(let text)? = result["text"] {
                line = text
            }
            return .ended(
                sessionId: id, channelId: channelId, reason: AppEndReason(wire: e.reason),
                summary: AppEndSummary(
                    participants: summary?.participants ?? 0,
                    durationSeconds: summary?.durationSeconds ?? 0,
                    resultText: line
                )
            )
        case "app-error":
            guard let id = e.sessionId else { return nil }
            return .error(
                sessionId: id,
                op: AppErrorOp(rawValue: e.op ?? "") ?? .join,
                code: AppErrorCode(rawValue: e.code ?? "") ?? .unknown
            )
        default:
            return nil
        }
    }

    /// `"session": null` present in the frame, as opposed to the key missing or
    /// an object this build could not read.
    private static func hasNullSession(_ data: Data) -> Bool {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
        return object["session"] is NSNull
    }

    var sessionId: String? {
        switch self {
        case .channelApp(_, let session): session?.id
        case .session(let snapshot): snapshot.sessionId
        case .state(let id, _, _), .event(let id, _, _, _), .ended(let id, _, _, _), .error(let id, _, _): id
        }
    }
}
