import Foundation
@preconcurrency import CallKit
@preconcurrency import AVFoundation
import WebRTC

/// Which pqp room a CallKit call UUID stands for.
///
/// CallKit only ever knows a call by a UUID it is handed at report time; this
/// is the other half of that mapping, kept as a value so the coordinator's
/// bookkeeping (`uuidsByRoom`, `roomsByUUID`) can be exercised without any of
/// CallKit itself.
enum CallKitRoom: Equatable, Hashable, Sendable {
    /// A DM or group call, keyed by the conversation's channel id. Owned by
    /// `CallModel`.
    case conversation(String)
    /// A server voice channel, keyed by its channel id. Owned by
    /// `VoiceModel`. Never rung, see `CallKitRoomHandling.callKitAnswer`.
    case channel(String)
}

/// What a room owner (`CallModel` or `VoiceModel`) does when CallKit tells
/// this app to act on a call: from the lock screen, CarPlay, Apple Watch or
/// Siri, never from this app's own UI (that keeps calling the existing
/// `accept`/`decline`/`hangUp`/`isMuted` API exactly as before; see
/// `docs/IOS_CALLKIT.md` "Why in-app buttons do not round-trip through
/// CallKit").
///
/// Every method takes the room it is about rather than assuming "my current
/// call": a stale system action landing after this device has already moved
/// on must be a no-op, not a hang-up of whatever the room owner is doing now.
@MainActor
protocol CallKitRoomHandling: AnyObject {
    /// CallKit is asking this room's call to answer. Only ever sent for a
    /// room that was reported with `reportIncomingCall`, a voice channel
    /// never gets this, because `VoiceModel` never reports one as incoming.
    func callKitAnswer(_ room: CallKitRoom)
    /// CallKit is ending this room's call: the person hung up from the lock
    /// screen or CarPlay, declined the incoming call there, or the system
    /// reset every call it is holding (`providerDidReset`). Must leave the
    /// room exactly as the in-app hang-up button would.
    func callKitEnd(_ room: CallKitRoom)
    /// The system mute toggle changed: lock screen, CarPlay, or an AirPods
    /// media button CallKit turned into a mute action. Maps straight onto
    /// pqp's own mute, the same control the in-app button drives.
    func callKitSetMuted(_ room: CallKitRoom, muted: Bool)
}

// MARK: - CXProvider and CXCallController behind protocols

/// The slice of `CXProvider` the coordinator calls, so a test can supply a
/// fake and exercise the state machine with no system call provider (a test
/// target has no telephony entitlement to register one for real).
@MainActor
protocol CXProviding: AnyObject {
    func setDelegate(_ delegate: CXProviderDelegate)
    func reportNewIncomingCall(
        uuid: UUID, update: CXCallUpdate, completion: @escaping (Error?) -> Void
    )
    func reportCallEnded(uuid: UUID, at date: Date, reason: CXCallEndedReason)
    func reportOutgoingCallStartedConnecting(uuid: UUID, at date: Date)
    func reportOutgoingCallConnected(uuid: UUID, at date: Date)
}

/// The slice of `CXCallController` the coordinator calls.
@MainActor
protocol CXCallControllerProviding: AnyObject {
    func request(_ transaction: CXTransaction, completion: @escaping (Error?) -> Void)
}

/// Real `CXProvider`, adapted to `CXProviding`.
///
/// A thin wrapper rather than a retroactive `extension CXProvider: CXProviding`
/// on purpose: it isolates every place this file depends on CallKit's exact
/// Swift-imported method names to one spot, so a future SDK rename is a
/// one-file fix instead of a search across the coordinator's own logic.
@MainActor
final class SystemCXProvider: CXProviding {
    private let provider: CXProvider

    init(configuration: CXProviderConfiguration) {
        provider = CXProvider(configuration: configuration)
    }

    func setDelegate(_ delegate: CXProviderDelegate) {
        // nil queue: callbacks land on the main queue, which is what lets
        // `CXProviderDelegate`'s methods below use `MainActor.assumeIsolated`
        // instead of hopping through an unstructured `Task`.
        provider.setDelegate(delegate, queue: nil)
    }

    func reportNewIncomingCall(
        uuid: UUID, update: CXCallUpdate, completion: @escaping (Error?) -> Void
    ) {
        provider.reportNewIncomingCall(with: uuid, update: update, completion: completion)
    }

    func reportCallEnded(uuid: UUID, at date: Date, reason: CXCallEndedReason) {
        provider.reportCall(with: uuid, endedAt: date, reason: reason)
    }

    func reportOutgoingCallStartedConnecting(uuid: UUID, at date: Date) {
        provider.reportOutgoingCall(with: uuid, startedConnectingAt: date)
    }

    func reportOutgoingCallConnected(uuid: UUID, at date: Date) {
        provider.reportOutgoingCall(with: uuid, connectedAt: date)
    }
}

/// Real `CXCallController`, adapted to `CXCallControllerProviding`.
@MainActor
final class SystemCXCallController: CXCallControllerProviding {
    private let controller = CXCallController()

    func request(_ transaction: CXTransaction, completion: @escaping (Error?) -> Void) {
        controller.request(transaction, completion: completion)
    }
}

// MARK: - Configuration

extension CXProviderConfiguration {
    /// pqp's one provider configuration.
    ///
    /// `supportsVideo = false`, deliberately, even though a DM call can turn
    /// a camera on: this only tells CallKit's OWN chrome (the lock screen,
    /// CarPlay, the Watch) not to draw video-call controls it has no picture
    /// to back. The in-app stage's camera button is unaffected, because it is
    /// not CallKit's to gate.
    static var pqp: CXProviderConfiguration {
        let configuration = CXProviderConfiguration()
        configuration.supportsVideo = false
        configuration.maximumCallGroups = 1
        configuration.maximumCallsPerCallGroup = 1
        configuration.supportedHandleTypes = [.generic]
        configuration.includesCallsInRecents = true
        // No ringtone ships in the bundle yet (`docs/IOS_CALLKIT.md`); this
        // picks one up with no other change the day one does, matching the
        // "ringtone from the app if one exists" brief. There is currently
        // none, so CallKit falls back to the system's own.
        for name in ["ringtone.caf", "ringtone.wav", "ringtone.aiff"] {
            let base = (name as NSString).deletingPathExtension
            let ext = (name as NSString).pathExtension
            if Bundle.main.url(forResource: base, withExtension: ext) != nil {
                configuration.ringtoneSound = name
                break
            }
        }
        return configuration
    }
}

// MARK: - The coordinator

/// Reports pqp voice rooms to CallKit and carries out what CallKit asks back:
/// system call UI on the lock screen, answer/decline, and the audio session
/// handoff a CallKit call requires.
///
/// One instance for the whole app, app-wide for the same reason `CallModel`
/// and `VoiceModel` are (`PqpApp.swift`): a system answer can arrive with no
/// screen of this app's on top, and the provider itself must not be recreated
/// mid-call.
///
/// SPLIT DELIBERATELY IN ONE DIRECTION. CallKit-to-app (a system answer, a
/// system hang-up, the lock-screen mute toggle) always runs through
/// `CXProviderDelegate` below, which is the only door those surfaces have:
/// there is no other way for CarPlay or the lock screen to tell this app
/// anything. App-to-CallKit (the in-app Accept/Decline/Hang Up buttons,
/// `CallModel.isMuted`) keeps calling the existing model methods exactly as
/// before and additionally, directly, tells this coordinator what happened
/// (`reportOutgoingCall`, `reportIncomingCall`, `reportCallEnded`) rather than
/// round-tripping an in-app tap through `CXCallController` first. That keeps
/// this a small, additive layer over `CallModel`/`VoiceModel` rather than a
/// rewrite of either, at the cost of one honestly-documented gap: an
/// in-app-only mute never re-syncs the system's own mute icon. See
/// `docs/IOS_CALLKIT.md`.
@MainActor
final class CallKitCoordinator: NSObject {
    private let provider: CXProviding
    private let callController: CXCallControllerProviding

    /// The two room owners. Weak: neither outlives the app, and the
    /// coordinator must never be what keeps one alive.
    weak var callDelegate: CallKitRoomHandling?
    weak var channelDelegate: CallKitRoomHandling?

    private var uuidsByRoom: [CallKitRoom: UUID] = [:]
    private var roomsByUUID: [UUID: CallKitRoom] = [:]
    /// Rooms already reported connected, so a second `voicePeerJoined` or a
    /// resumed `welcome` does not call `reportOutgoingCall(connectedAt:)`
    /// twice for the same call.
    private var connectedRooms: Set<CallKitRoom> = []
    /// Whether this is the app's one real coordinator rather than a test's
    /// instance built on fakes. Read by `activateAudioWithoutCallKit` too:
    /// a fake coordinator's "CallKit refused" fallback must not touch the
    /// real, process-wide `RTCAudioSession` either, for the same reason
    /// `init` below only flips `useManualAudio` for the real one.
    private let isReal: Bool

    init(
        provider: CXProviding? = nil,
        callController: CXCallControllerProviding = SystemCXCallController()
    ) {
        // Whether this is the one real coordinator the app wires up, versus
        // a test's instance built on fakes. `RTCAudioSession` is a process
        // singleton, and `pqpTests` runs every test in one process: a fake
        // coordinator flipping `useManualAudio` on would leak into every
        // OTHER test that exercises `VoiceClient.startAudio()` afterward,
        // with nothing left in the process to ever call
        // `audioSessionDidActivate` and turn the audio engine back on. This
        // is not hypothetical, it crashed `VoiceRosterDeltaTests` the first
        // time this file's own tests ran in the same process.
        isReal = provider == nil
        self.provider = provider ?? SystemCXProvider(configuration: .pqp)
        self.callController = callController
        super.init()
        self.provider.setDelegate(self)
        guard isReal else { return }
        // From here on WebRTC's own audio unit only starts when THIS
        // coordinator says so (`provider(_:didActivate:)`), never on its own:
        // that is the mistake this file exists to avoid. `startAudio` in
        // `VoiceClient` reads this same flag and skips its old direct
        // `setActive(true)` once it is set, which is what makes this line
        // the single switch between the two behaviours.
        RTCAudioSession.sharedInstance().useManualAudio = true
    }

    /// Which owner a room belongs to.
    private func delegate(for room: CallKitRoom) -> CallKitRoomHandling? {
        switch room {
        case .conversation: callDelegate
        case .channel: channelDelegate
        }
    }

    private func roomHandle(_ room: CallKitRoom) -> CXHandle {
        switch room {
        case .conversation(let id), .channel(let id):
            CXHandle(type: .generic, value: id)
        }
    }

    // MARK: - App to CallKit

    /// The user placed a call (a DM ring) or joined a voice channel.
    ///
    /// A no-op if this room already has a UUID: `start()`/`join()` guard
    /// against a second call while one is live, but a defensive check here
    /// means a caller mistake never registers the same room twice.
    func reportOutgoingCall(room: CallKitRoom, displayName: String, hasVideo: Bool = false) {
        guard uuidsByRoom[room] == nil else { return }
        let uuid = UUID()
        uuidsByRoom[room] = uuid
        roomsByUUID[uuid] = room

        let startAction = CXStartCallAction(call: uuid, handle: roomHandle(room))
        startAction.isVideo = hasVideo
        startAction.contactIdentifier = displayName
        callController.request(CXTransaction(action: startAction)) { [weak self] error in
            guard let self else { return }
            guard error == nil else {
                // CallKit refused the registration (a Screen Time restriction,
                // every call slot in use, or a simulator quirk). The room
                // itself is unaffected, it is simply invisible to the lock
                // screen, CarPlay and Recents, but nobody will ever call
                // `provider(_:didActivate:)` for it, so the fallback below
                // activates audio the pre-CallKit way rather than leaving the
                // call silent under `useManualAudio`.
                self.forgetRoom(room)
                self.activateAudioWithoutCallKit()
                return
            }
            self.provider.reportOutgoingCallStartedConnecting(uuid: uuid, at: Date())
        }
    }

    /// Somebody else joined the room: it is no longer just ringing out.
    func reportConnected(room: CallKitRoom) {
        guard let uuid = uuidsByRoom[room], !connectedRooms.contains(room) else { return }
        connectedRooms.insert(room)
        provider.reportOutgoingCallConnected(uuid: uuid, at: Date())
    }

    /// A `call-incoming` ring arrived over the socket. Puts pqp's own ring on
    /// the lock screen, CarPlay and the Watch, not only the in-app banner.
    ///
    /// `onPresented` fires exactly once and says whether CallKit is now
    /// presenting this ring as a system call: `true` when the report was
    /// accepted (or the room was already reported), `false` when CallKit
    /// refused it (Screen Time, every call slot in use, the simulator). The
    /// room owner uses that to decide whether to also draw its own in-app
    /// banner — it must not, while CallKit has the ring, or the call shows up
    /// as two competing incoming-call surfaces at once. See
    /// `incomingCallBannerRing` and `docs/IOS_CALLKIT.md`.
    func reportIncomingCall(
        room: CallKitRoom,
        callerName: String,
        onPresented: @escaping (_ presented: Bool) -> Void = { _ in }
    ) {
        guard uuidsByRoom[room] == nil else {
            // Already reported — CallKit is presenting it, so the caller
            // should keep suppressing its own banner.
            onPresented(true)
            return
        }
        let uuid = UUID()
        uuidsByRoom[room] = uuid
        roomsByUUID[uuid] = room

        let update = CXCallUpdate()
        update.remoteHandle = roomHandle(room)
        update.localizedCallerName = callerName
        update.hasVideo = false
        update.supportsHolding = false
        update.supportsGrouping = false
        update.supportsUngrouping = false
        update.supportsDTMF = false

        provider.reportNewIncomingCall(uuid: uuid, update: update) { [weak self] error in
            guard let self else { return }
            guard error == nil else {
                // CallKit refused. The in-app banner (`IncomingCallBanner`)
                // takes over as the fallback ring surface; this only means
                // the lock screen/CarPlay never learn about it, the same
                // degrade as a refused outgoing report.
                self.forgetRoom(room)
                onPresented(false)
                return
            }
            onPresented(true)
        }
    }

    /// The room ended for any reason this app decided on its own: a normal
    /// hang-up, a decline, a ring that timed out, a join that failed. Not
    /// called for a CallKit-initiated end: `provider(_:perform: CXEndCallAction)`
    /// below removes the mapping itself before the room owner's own cleanup
    /// runs, so the matching call from `hangUp`/`leave` finds nothing to
    /// report and quietly does nothing.
    func reportCallEnded(room: CallKitRoom, reason: CXCallEndedReason) {
        guard let uuid = uuidsByRoom[room] else { return }
        forgetRoom(room)
        provider.reportCallEnded(uuid: uuid, at: Date(), reason: reason)
    }

    private func forgetRoom(_ room: CallKitRoom) {
        if let uuid = uuidsByRoom.removeValue(forKey: room) {
            roomsByUUID.removeValue(forKey: uuid)
        }
        connectedRooms.remove(room)
    }

    /// The pre-CallKit path, used only when CallKit itself refused to take
    /// the call: activates the session directly rather than leaving the room
    /// mute under `useManualAudio` with nothing left to turn it on. A no-op
    /// for a fake coordinator: `init` never put the real singleton into
    /// manual mode for one, so there is nothing here to fall back from, and
    /// touching the process's real `RTCAudioSession` from a test would be
    /// its own bug.
    private func activateAudioWithoutCallKit() {
        guard isReal else { return }
        let session = RTCAudioSession.sharedInstance()
        session.lockForConfiguration()
        try? session.setActive(true)
        session.unlockForConfiguration()
        session.isAudioEnabled = true
    }
}

// MARK: - CXProviderDelegate

extension CallKitCoordinator: CXProviderDelegate {
    /// CallKit reset every call it is holding. Treated exactly like every
    /// room this coordinator knew about being ended from the system side.
    nonisolated func providerDidReset(_ provider: CXProvider) {
        MainActor.assumeIsolated {
            for room in self.roomsByUUID.values {
                self.delegate(for: room)?.callKitEnd(room)
            }
            self.uuidsByRoom.removeAll()
            self.roomsByUUID.removeAll()
            self.connectedRooms.removeAll()
        }
    }

    /// Only reached if something OTHER than this coordinator asked CallKit to
    /// start a call with pqp's provider: Siri or a Recents redial, since this
    /// app never hands out a `CXHandle` a person could tap to redial in the
    /// system's own UI today. Fulfilled defensively so a stray action never
    /// times out and drops the provider's whole transaction queue.
    nonisolated func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        MainActor.assumeIsolated {
            self.provider.reportOutgoingCallStartedConnecting(uuid: action.callUUID, at: Date())
            action.fulfill()
        }
    }

    /// The system answered on this app's behalf: lock screen, CarPlay, Apple
    /// Watch or Siri. The one door those surfaces have into pqp.
    nonisolated func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        MainActor.assumeIsolated {
            guard let room = self.roomsByUUID[action.callUUID] else {
                action.fail()
                return
            }
            self.delegate(for: room)?.callKitAnswer(room)
            action.fulfill()
        }
    }

    /// The system ended the call: hang up, decline, or a Recents "End Call".
    /// The mapping is forgotten BEFORE the room owner's own hang-up runs, so
    /// its own (app-side) `reportCallEnded` call, moments later, finds
    /// nothing left to report and does not double up.
    nonisolated func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        MainActor.assumeIsolated {
            guard let room = self.roomsByUUID[action.callUUID] else {
                action.fulfill()
                return
            }
            self.forgetRoom(room)
            self.delegate(for: room)?.callKitEnd(room)
            action.fulfill()
        }
    }

    /// The lock screen, CarPlay or an AirPods media-button mute. Maps
    /// straight onto pqp's own mute.
    nonisolated func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        MainActor.assumeIsolated {
            guard let room = self.roomsByUUID[action.callUUID] else {
                action.fail()
                return
            }
            self.delegate(for: room)?.callKitSetMuted(room, muted: action.isMuted)
            action.fulfill()
        }
    }

    /// THIS is where WebRTC's audio engine is allowed to start, never before.
    /// `RTCAudioSession.audioSessionDidActivate` is the hook WebRTC ships
    /// specifically for a host that hands audio-session activation to
    /// something else (here, CallKit). Calling `setActive` ourselves ahead of
    /// this, under `useManualAudio`, is the mistake this file exists to
    /// avoid: two callers fighting over one audio session, one of them
    /// silent.
    nonisolated func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        RTCAudioSession.sharedInstance().audioSessionDidActivate(audioSession)
    }

    nonisolated func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        RTCAudioSession.sharedInstance().audioSessionDidDeactivate(audioSession)
    }
}
