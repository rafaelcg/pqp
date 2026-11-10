import Foundation

/// The phone's half of the sandbox message API v1 (`packages/shared/src/apps/bridge.ts`,
/// docs/APPS.md "The bridge"): the same contract the web client's `BridgeHost`
/// keeps, for one app frame. The app is untrusted. So:
///
/// - every message from it is parsed STRICTLY: an unknown key is a rejection,
///   answered `invalid` (or dropped when it carries no usable request id);
/// - the manifest's caps are enforced here AGAIN (the server enforces them for
///   real): events per second and bytes, state bytes counted on the MERGED
///   state, who may write;
/// - what goes back is built from scratch (a seat id, a cleaned name, an avatar
///   data URL: never a pqp user id, a token, a server or a channel id);
/// - a flood is answered `rate-limited` without parsing, and a sustained one is
///   reported through `onViolation`.
///
/// WHAT THIS PHASE ANSWERS. State, events, participants, `ui.*`, and `session.end`.
/// Everything that needs bytes or a device (`assets`, `files.*`, `store.*`,
/// `sync.*`, `share.*`) is `not-allowed`, the answer an app already reads as
/// "this host has no such grant" and falls back from. The bridge never throws
/// to the webview; a failure is an error response.
///
/// It talks to the session through `AppBridgeTransport`, so it is tested with a
/// fake, with no webview and no socket.

/// A refusal from the session, in the codes `app-error` speaks.
struct AppTransportError: Error, Equatable {
    let code: AppErrorCode
}

@MainActor
protocol AppBridgeTransport: AnyObject {
    /// `app-state-patch`; resolves with the revision the server gave the write.
    func patchState(_ patch: JSONValue, baseRev: Int?) async throws -> Int
    /// `app-event-send`. Not acknowledged: events are ephemeral.
    func sendEvent(name: String, data: JSONValue)
    /// `POST /api/app-sessions/:id/end`.
    func endSession() async throws
}

/// What an app may be told about one person (`bridgeParticipantSchema`).
struct BridgeParticipant: Equatable, Sendable {
    let seatId: String
    let displayName: String
    /// A data URL the host fetched and shrank, or nil. Never a link the app could load.
    let avatar: String?
    let role: AppRole
    let isHost: Bool
    let connection: AppConnection
    let appUserId: String?

    var json: JSONValue {
        var fields: [String: JSONValue] = [
            "seatId": .string(seatId),
            "displayName": .string(displayName),
            "avatar": avatar.map(JSONValue.string) ?? .null,
            "role": .string(role.rawValue),
            "isHost": .bool(isHost),
            "connection": .string(connection.rawValue),
        ]
        if let appUserId { fields["appUserId"] = .string(appUserId) }
        return .object(fields)
    }
}

enum BridgeError: String, Sendable {
    case notAllowed = "not-allowed"
    case notHost = "not-host"
    case tooLarge = "too-large"
    case rateLimited = "rate-limited"
    case staleRev = "stale-rev"
    case cancelled
    case unavailable
    case ended
    case invalid
}

@MainActor
final class AppBridge {
    struct Options {
        var app: AppEntry
        var locale: String
        var theme: [String: String]
        var reducedMotion: Bool
        var now: () -> Date = Date.init
    }

    private let options: Options
    private weak var transport: (any AppBridgeTransport)?
    /// Everything the bridge sends to the app, already JSON. The webview wrapper
    /// posts it on the message port.
    private let post: (JSONValue) -> Void

    var onResize: ((Int) -> Void)?
    var onActivity: ((String) -> Void)?
    var onViolation: (() -> Void)?

    private let stateCap: (maxBytes: Int, writers: String)
    private let eventCap: (maxPerSecond: Int, maxBytes: Int)
    private var eventBucket: AppTokenBucket
    private var stateBucket: AppTokenBucket
    private var floodBucket: AppTokenBucket
    private var floodStrikes = 0
    private var violated = false

    private(set) var attached = false
    private var snapshot: AppSeatSnapshot?
    private(set) var state: (rev: Int, value: JSONValue) = (0, .null)
    private var stateKnown = false
    private var roster: [BridgeParticipant]?
    private var waitingForRoster: [String] = []
    private var connectionOnline = true
    private(set) var endedReason: AppEndReason?

    init(options: Options, transport: any AppBridgeTransport, post: @escaping (JSONValue) -> Void) {
        self.options = options
        self.transport = transport
        self.post = post
        let app = options.app
        stateCap = (
            maxBytes: min(app.state.maxBytes, AppLimits.stateMaxBytes),
            writers: app.state.writers
        )
        eventCap = (
            maxPerSecond: min(app.events.maxPerSecond, AppLimits.eventMaxPerSecond),
            maxBytes: min(app.events.maxBytes, AppLimits.eventMaxBytes)
        )
        let writes = Double(min(app.state.maxWritesPerSecond, AppLimits.stateMaxWritesPerSecond))
        let events = Double(eventCap.maxPerSecond)
        let now = options.now
        eventBucket = AppTokenBucket(perSecond: events, burst: max(1, events), now: now)
        stateBucket = AppTokenBucket(perSecond: writes, burst: max(1, writes), now: now)
        floodBucket = AppTokenBucket(perSecond: 100, burst: 200, now: now)
    }

    // MARK: - What the session tells us

    /// The seat the session gave. Must be known before `attach()`: the `hello`
    /// carries it.
    func applySnapshot(_ next: AppSeatSnapshot) {
        snapshot = next
        applyState(rev: next.stateRev, value: next.stateValue)
    }

    func applyState(rev: Int, value: JSONValue) {
        // A revision never goes backwards, and the same one is a duplicate (a resume re-sends it).
        if stateKnown, rev <= state.rev { return }
        stateKnown = true
        state = (rev, value)
        push(["type": .string("state"), "rev": .number(Double(rev)), "value": value])
    }

    func applyEvent(fromSeatId: String, name: String, data: JSONValue) {
        push([
            "type": .string("event"), "fromSeatId": .string(fromSeatId),
            "name": .string(name), "data": data,
        ])
    }

    /// The roster, built by the host from the latest snapshot (names and avatars
    /// are resolved there). Pushed only when it changed.
    func setParticipants(_ next: [BridgeParticipant]) {
        let fitted = Self.fitAvatarBudget(Array(next.prefix(AppLimits.maxParticipants)))
        let changed = roster != fitted
        roster = fitted
        let waiting = waitingForRoster
        waitingForRoster = []
        for id in waiting { succeed(id, type: "participants.get", result: participantsResult()) }
        if changed, attached { push(["type": .string("participants"), "participants": participantsList()]) }
    }

    func setConnection(online: Bool) {
        guard connectionOnline != online else { return }
        connectionOnline = online
        push(["type": .string("connection"), "status": .string(online ? "online" : "reconnecting")])
    }

    func setEnded(_ reason: AppEndReason) {
        guard endedReason == nil else { return }
        endedReason = reason
        push(["type": .string("session.ended"), "reason": .string(Self.wire(reason))])
        for id in waitingForRoster { fail(id, .ended) }
        waitingForRoster = []
    }

    func setTheme(_ theme: [String: String]) {
        push(["type": .string("theme"), "theme": Self.themeJSON(theme)])
    }

    /// The port was handed over: say `hello`, then the roster if it is ready.
    func attach() {
        guard !attached, let snapshot else { return }
        attached = true
        var theme = options.theme
        if theme.count > AppLimits.themeMaxTokens {
            theme = Dictionary(uniqueKeysWithValues: theme.sorted { $0.key < $1.key }.prefix(AppLimits.themeMaxTokens).map { ($0.key, $0.value) })
        }
        post(.object([
            "type": .string("hello"),
            "platformApi": .number(Double(AppLimits.platformApi)),
            "app": .object(["id": .string(options.app.id), "version": .string(options.app.version)]),
            "locale": .string(Self.safeLocale(options.locale)),
            "theme": Self.themeJSON(theme),
            "reducedMotion": .bool(options.reducedMotion),
            "self": .object([
                "seatId": .string(snapshot.seatId),
                "role": .string(snapshot.role.rawValue),
                "isHost": .bool(snapshot.isHost),
            ]),
            "connection": .string(connectionOnline ? "online" : "reconnecting"),
        ]))
        if roster != nil { push(["type": .string("participants"), "participants": participantsList()]) }
    }

    func detach() {
        attached = false
        waitingForRoster = []
    }

    // MARK: - What the app asks

    /// One message from the page's port, as JSON text.
    func receive(_ text: String) {
        guard !violated else { return }
        guard floodBucket.take() else {
            floodStrikes += 1
            if let id = Self.idOf(JSONValue.parse(text)) { fail(id, .rateLimited) }
            if floodStrikes >= 500, !violated {
                violated = true
                onViolation?()
            }
            return
        }
        guard let raw = JSONValue.parse(text) else { return }
        guard let message = Self.parse(raw) else {
            if let id = Self.idOf(raw) { fail(id, .invalid) }
            return
        }
        Task { [weak self] in await self?.handle(message) }
    }

    private func handle(_ message: Request) async {
        let id = message.id
        if endedReason != nil { return fail(id, .ended) }
        guard let snapshot else { return fail(id, .unavailable) }

        switch message.type {
        case "participants.get":
            if roster != nil {
                succeed(id, type: message.type, result: participantsResult())
            } else {
                waitingForRoster.append(id)
            }

        case "state.get":
            succeed(id, type: message.type, result: .object([
                "rev": .number(Double(state.rev)), "value": state.value,
            ]))

        case "state.patch":
            guard let patch = message.fields["patch"] else { return fail(id, .invalid) }
            if let refusal = checkStateWrite(patch, isHost: snapshot.isHost, role: snapshot.role) {
                return fail(id, refusal)
            }
            let baseRev = message.fields["baseRev"]?.intValue
            guard let transport else { return fail(id, .unavailable) }
            do {
                let rev = try await transport.patchState(patch, baseRev: baseRev)
                succeed(id, type: message.type, result: .object(["rev": .number(Double(rev))]))
            } catch let error as AppTransportError {
                fail(id, Self.map(error.code))
            } catch {
                fail(id, .unavailable)
            }

        case "events.send":
            guard let name = message.fields["name"]?.stringValue, let data = message.fields["data"] else {
                return fail(id, .invalid)
            }
            if let refusal = checkEventSend(data, role: snapshot.role) { return fail(id, refusal) }
            transport?.sendEvent(name: name, data: data)
            succeed(id, type: message.type, result: .null)

        case "ui.resize":
            guard let height = message.fields["height"]?.intValue else { return fail(id, .invalid) }
            onResize?(height)
            succeed(id, type: message.type, result: .object(["height": .number(Double(height))]))

        case "ui.fullscreen":
            // The activity already has the whole screen on a phone.
            let on = message.fields["on"]?.boolValue ?? false
            succeed(id, type: message.type, result: .object(["on": .bool(on)]))

        case "ui.activity":
            if let state = message.fields["state"]?.stringValue { onActivity?(state) }
            succeed(id, type: message.type, result: .null)

        case "session.end":
            guard snapshot.isHost else { return fail(id, .notHost) }
            guard let transport else { return fail(id, .unavailable) }
            do {
                try await transport.endSession()
                succeed(id, type: message.type, result: .null)
            } catch let error as AppTransportError {
                fail(id, Self.map(error.code, forEnd: true))
            } catch {
                fail(id, .unavailable)
            }

        default:
            // `assets`, `files`, `store`, `sync`, `share`: a host with no such
            // grant. An app falls back to memory and says nothing about it.
            fail(id, .notAllowed)
        }
    }

    private func checkStateWrite(_ patch: JSONValue, isHost: Bool, role: AppRole) -> BridgeError? {
        if !connectionOnline { return .unavailable }
        if role == .spectator { return .notAllowed }
        if stateCap.writers == "host", !isHost { return .notHost }
        if !stateBucket.take() { return .rateLimited }
        if let _ = AppJSON.problem(patch, maxBytes: stateCap.maxBytes) { return .tooLarge }
        if AppJSON.bytesAfter(state.value, patch: patch) > stateCap.maxBytes { return .tooLarge }
        return nil
    }

    private func checkEventSend(_ data: JSONValue, role: AppRole) -> BridgeError? {
        if !connectionOnline { return .unavailable }
        if role == .spectator { return .notAllowed }
        if eventCap.maxPerSecond == 0 || eventCap.maxBytes == 0 { return .notAllowed }
        if AppJSON.problem(data, maxBytes: eventCap.maxBytes) != nil { return .tooLarge }
        if !eventBucket.take() { return .rateLimited }
        return nil
    }

    // MARK: - Parsing (strict)

    struct Request {
        let id: String
        let type: String
        let fields: [String: JSONValue]
    }

    /// The keys each request may carry besides `id` and `type`, `required` first.
    /// Anything else is a rejection. Requests this phase does not serve are
    /// matched on their key set too, so a malformed one reads `invalid` and a
    /// well-formed one `not-allowed`, as on the web.
    nonisolated private static let shapes: [String: (required: Set<String>, optional: Set<String>)] = [
        "participants.get": ([], []),
        "state.get": ([], []),
        "state.patch": (["patch"], ["baseRev"]),
        "events.send": (["name", "data"], []),
        "assets.get": (["name"], []),
        "files.pickLocal": ([], []),
        "store.get": (["key"], []),
        "store.put": (["key", "bytes"], ["meta"]),
        "store.delete": (["key"], []),
        "store.list": (["prefix"], []),
        "store.usage": ([], []),
        "files.saveLocal": (["bytes", "ext"], []),
        "sync.status": ([], []),
        "sync.list": (["game"], []),
        "sync.get": (["save"], []),
        "sync.put": (["game", "kind", "slot", "baseRev", "bytes", "platform", "core", "coreVersion"], ["thumb"]),
        "sync.delete": (["save"], []),
        "sync.restore": (["save", "baseRev"], []),
        "sync.clear": ([], ["game"]),
        "ui.resize": (["height"], []),
        "ui.fullscreen": (["on"], []),
        "share.request": (["on"], []),
        "share.audio": (["rate", "channels", "samples"], []),
        "session.end": ([], []),
        "ui.activity": (["state"], []),
    ]

    nonisolated private static let eventNamePattern = try! NSRegularExpression(pattern: "^[a-z][a-z0-9.-]{0,31}$")

    nonisolated static func parse(_ raw: JSONValue) -> Request? {
        guard case .object(var fields) = raw,
              let id = fields.removeValue(forKey: "id")?.stringValue, (1...32).contains(id.count),
              let type = fields.removeValue(forKey: "type")?.stringValue,
              let shape = shapes[type] else { return nil }
        let keys = Set(fields.keys)
        guard shape.required.isSubset(of: keys), keys.isSubset(of: shape.required.union(shape.optional)) else { return nil }
        // The values the served requests read must have their kind; the rest
        // are answered `not-allowed` without looking at them.
        switch type {
        case "state.patch":
            if let base = fields["baseRev"], base.intValue.map({ $0 >= 0 }) != true { return nil }
        case "events.send":
            guard let name = fields["name"]?.stringValue,
                  eventNamePattern.firstMatch(in: name, range: NSRange(name.startIndex..., in: name)) != nil
            else { return nil }
        case "ui.resize":
            guard let height = fields["height"]?.intValue,
                  (AppLimits.uiMinHeight...AppLimits.uiMaxHeight).contains(height) else { return nil }
        case "ui.fullscreen", "share.request":
            guard fields["on"]?.boolValue != nil else { return nil }
        case "ui.activity":
            guard let state = fields["state"]?.stringValue,
                  ["playing", "paused", "browsing"].contains(state) else { return nil }
        default:
            break
        }
        return Request(id: id, type: type, fields: fields)
    }

    nonisolated static func idOf(_ raw: JSONValue?) -> String? {
        guard case .object(let fields)? = raw, let id = fields["id"]?.stringValue, (1...32).contains(id.count)
        else { return nil }
        return id
    }

    // MARK: - Sending

    private func push(_ fields: [String: JSONValue]) {
        guard attached else { return }
        post(.object(fields))
    }

    private func fail(_ id: String, _ error: BridgeError) {
        post(.object(["id": .string(id), "ok": .bool(false), "error": .string(error.rawValue)]))
    }

    private func succeed(_ id: String, type: String, result: JSONValue) {
        post(.object(["id": .string(id), "ok": .bool(true), "type": .string(type), "result": result]))
    }

    private func participantsList() -> JSONValue { .array((roster ?? []).map(\.json)) }
    private func participantsResult() -> JSONValue { .object(["participants": participantsList()]) }

    // MARK: - Helpers

    nonisolated static func map(_ code: AppErrorCode, forEnd: Bool = false) -> BridgeError {
        switch code {
        case .notAllowed: forEnd ? .notHost : .notAllowed
        case .ended: .ended
        case .rateLimited: .rateLimited
        case .tooLarge: .tooLarge
        case .staleRev: .staleRev
        // `full` and `unavailable`: nothing an app can act on except trying again.
        default: .unavailable
        }
    }

    nonisolated static func wire(_ reason: AppEndReason) -> String {
        reason == .unknown ? "host" : reason.rawValue
    }

    nonisolated private static let localePattern = try! NSRegularExpression(
        pattern: "^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$"
    )

    nonisolated static func safeLocale(_ tag: String) -> String {
        localePattern.firstMatch(in: tag, range: NSRange(tag.startIndex..., in: tag)) != nil ? tag : "en"
    }

    nonisolated static func themeJSON(_ theme: [String: String]) -> JSONValue {
        .object(theme.mapValues { .string(String($0.prefix(256))) })
    }

    /// A roster's avatars add up to at most `avatarsBudgetChars`. Past that the
    /// largest are left out (the app draws its own fallback) until the rest fit.
    nonisolated static func fitAvatarBudget(_ list: [BridgeParticipant]) -> [BridgeParticipant] {
        var total = list.reduce(0) { $0 + ($1.avatar?.count ?? 0) }
        guard total > AppLimits.avatarsBudgetChars else { return list }
        let bySize = list.enumerated()
            .filter { ($0.element.avatar?.count ?? 0) > 0 }
            .sorted { ($0.element.avatar?.count ?? 0, $1.offset) > ($1.element.avatar?.count ?? 0, $0.offset) }
        var dropped = Set<Int>()
        for entry in bySize {
            if total <= AppLimits.avatarsBudgetChars { break }
            dropped.insert(entry.offset)
            total -= entry.element.avatar?.count ?? 0
        }
        return list.enumerated().map { index, person in
            dropped.contains(index)
                ? BridgeParticipant(
                    seatId: person.seatId, displayName: person.displayName, avatar: nil, role: person.role,
                    isHost: person.isHost, connection: person.connection, appUserId: person.appUserId
                )
                : person
        }
    }

    /// A name an app may draw: no control or bidi characters, trimmed, at most 64
    /// UTF-16 units, never empty (`cleanDisplayName`).
    nonisolated static func cleanDisplayName(_ name: String?) -> String {
        var scalars = String.UnicodeScalarView()
        for scalar in (name ?? "").unicodeScalars where !isUnsafe(scalar) { scalars.append(scalar) }
        let cleaned = String(scalars).trimmingCharacters(in: .whitespacesAndNewlines)
        var out = ""
        for character in cleaned {
            if out.utf16.count + String(character).utf16.count > AppLimits.displayNameMaxChars { break }
            out.append(character)
        }
        return out.isEmpty ? "?" : out
    }

    nonisolated private static func isUnsafe(_ scalar: Unicode.Scalar) -> Bool {
        let v = scalar.value
        return v <= 0x1F || (0x7F...0x9F).contains(v) || v == 0x200E || v == 0x200F
            || (0x202A...0x202E).contains(v) || (0x2066...0x2069).contains(v)
    }
}
