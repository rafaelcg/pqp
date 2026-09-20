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

// MARK: - WebRTC's audio session behind a protocol

/// The slice of WebRTC's process-wide `RTCAudioSession` this coordinator
/// drives, behind a protocol for two reasons.
///
/// One, so the CallKit audio handshake can be pinned by a test at all:
/// `RTCAudioSession.sharedInstance()` is a real WebRTC singleton, so a test
/// that let the coordinator touch it directly would both depend on the
/// simulator's audio hardware and leak state into every other test in the
/// same process (see `CallKitCoordinator.init`). A fake standing in here
/// records the handshake instead.
///
/// Two, and this is the bug this seam exists to make impossible to reintroduce
/// silently: with `useManualAudio` on, notifying WebRTC that the session
/// activated (`audioSessionDidActivate`) is **not** enough to make the call
/// audible. WebRTC's VoIP audio unit stays uninitialised, in both directions,
/// until `isAudioEnabled` is set true, and it must be set false again when the
/// session deactivates. Those are two separate operations, and the coordinator
/// has to sequence both; keeping `setAudioEnabled` a first-class method here
/// (rather than folding it inside a single `didActivate`) is what lets a test
/// assert the coordinator actually performs it.
@MainActor
protocol WebRTCAudioControlling: AnyObject {
    /// Hand the VoIP audio unit's lifetime to the coordinator: from here on
    /// WebRTC does not start it on its own, only when `setAudioEnabled(true)`.
    func enableManualAudio()
    /// Tell WebRTC that CallKit activated the shared `AVAudioSession`.
    func notifyDidActivate(_ session: AVAudioSession)
    /// Tell WebRTC that CallKit deactivated the shared `AVAudioSession`.
    func notifyDidDeactivate(_ session: AVAudioSession)
    /// Permit (true) or stop and uninitialise (false) WebRTC's VoIP audio
    /// unit. Under `useManualAudio`, THE line whose absence left every
    /// CallKit-carried call silent: `audioSessionDidActivate` alone never
    /// starts the unit.
    func setAudioEnabled(_ enabled: Bool)
    /// The CallKit-refused fallback: activate the audio session directly, the
    /// pre-CallKit way, so a refused report degrades to "no lock-screen card"
    /// rather than "no audio at all".
    func activateSessionDirectly()
}

/// Real implementation, driving the WebRTC `RTCAudioSession` singleton. A thin
/// wrapper for the same reason `SystemCXProvider` is: it isolates every place
/// this file depends on WebRTC's exact audio-session API to one spot.
@MainActor
final class SystemWebRTCAudioControl: WebRTCAudioControlling {
    private var session: RTCAudioSession { RTCAudioSession.sharedInstance() }

    func enableManualAudio() {
        session.useManualAudio = true
    }

    func notifyDidActivate(_ audioSession: AVAudioSession) {
        session.audioSessionDidActivate(audioSession)
    }

    func notifyDidDeactivate(_ audioSession: AVAudioSession) {
        session.audioSessionDidDeactivate(audioSession)
    }

    func setAudioEnabled(_ enabled: Bool) {
        session.isAudioEnabled = enabled
    }

    func activateSessionDirectly() {
        let session = self.session
        session.lockForConfiguration()
        try? session.setActive(true)
        session.unlockForConfiguration()
    }
}

/// A do-nothing stand-in used by a coordinator built on a fake `CXProvider`
/// (i.e. a test) that did not inject its own audio control. It exists so such
/// a coordinator can never touch the real `RTCAudioSession` singleton even on
/// the fallback path, which would leak into the rest of the test process.
@MainActor
final class NoopWebRTCAudioControl: WebRTCAudioControlling {
    func enableManualAudio() {}
    func notifyDidActivate(_ session: AVAudioSession) {}
    func notifyDidDeactivate(_ session: AVAudioSession) {}
    func setAudioEnabled(_ enabled: Bool) {}
    func activateSessionDirectly() {}
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
    /// WebRTC's audio session, behind a protocol. The one real coordinator
    /// the app wires up gets `SystemWebRTCAudioControl`, which drives the
    /// process-wide `RTCAudioSession` singleton; a test built on a fake
    /// `CXProvider` that injects nothing gets `NoopWebRTCAudioControl`, so it
    /// can never touch that singleton and leak into another test.
    private let audio: WebRTCAudioControlling

    init(
        provider: CXProviding? = nil,
        callController: CXCallControllerProviding = SystemCXCallController(),
        audio: WebRTCAudioControlling? = nil
    ) {
        // A coordinator built with a real (nil) provider is the app's one, and
        // drives the real audio session; one built on a fake provider is a
        // test's, and must not. `RTCAudioSession` is a process singleton and
        // `pqpTests` runs every test in one process, so a test coordinator
        // touching it would leak `useManualAudio` into every OTHER test that
        // exercises `VoiceClient.startAudio()` afterward, with nothing left in
        // the process to call `audioSessionDidActivate` and turn the engine
        // back on. This is not hypothetical, it crashed `VoiceRosterDeltaTests`
        // the first time this file's own tests ran in the same process.
        self.provider = provider ?? SystemCXProvider(configuration: .pqp)
        self.callController = callController
        self.audio = audio ?? (provider == nil ? SystemWebRTCAudioControl() : NoopWebRTCAudioControl())
        super.init()
        self.provider.setDelegate(self)
        // From here on WebRTC's own audio unit only starts when THIS
        // coordinator says so (`provider(_:didActivate:)` sets it enabled),
        // never on its own: that is the mistake this file exists to avoid.
        // `startAudio` in `VoiceClient` reads `useManualAudio` and skips its
        // old direct `setActive(true)` once it is set, which is what makes
        // this the single switch between the two behaviours. (A no-op on the
        // Noop control, so a test coordinator leaves the singleton alone.)
        self.audio.enableManualAudio()
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
    func reportIncomingCall(room: CallKitRoom, callerName: String) {
        guard uuidsByRoom[room] == nil else { return }
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
                // The in-app banner (`IncomingCallBanner`) still rings; this
                // only means the lock screen/CarPlay never learn about it,
                // the same degrade as a refused outgoing report.
                self.forgetRoom(room)
                return
            }
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
    /// the call: activates the session directly AND enables the audio unit,
    /// rather than leaving the room mute under `useManualAudio` with nothing
    /// left to turn it on. Enabling audio is the same second step
    /// `provider(_:didActivate:)` performs on the CallKit path, and just as
    /// load-bearing here. A no-op on a test coordinator's Noop control.
    private func activateAudioWithoutCallKit() {
        audio.activateSessionDirectly()
        audio.setAudioEnabled(true)
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
    /// Two operations, both required, and the bug that stranded every
    /// CallKit-carried call in silence (video working throughout, since video
    /// needs no audio unit) was performing only the first:
    ///
    /// 1. `notifyDidActivate` -> `RTCAudioSession.audioSessionDidActivate`, the
    ///    hook WebRTC ships for a host that hands session activation to
    ///    something else (here, CallKit). This tells WebRTC the session is now
    ///    active; on its own it does NOT start the VoIP audio unit.
    /// 2. `setAudioEnabled(true)`. Under `useManualAudio` the unit stays
    ///    uninitialised until this is set, in both directions. Without it the
    ///    call is mute no matter that the session activated.
    ///
    /// Calling `setActive` ourselves ahead of this, under `useManualAudio`, is
    /// the other mistake this file avoids: two callers fighting over one audio
    /// session, one of them silent.
    nonisolated func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        MainActor.assumeIsolated {
            self.audio.notifyDidActivate(audioSession)
            self.audio.setAudioEnabled(true)
        }
    }

    /// The mirror of `didActivate`: hand the deactivation notice to WebRTC and
    /// stop the audio unit, so it is not left running against a session
    /// CallKit has torn down (an interruption, the call ending).
    nonisolated func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        MainActor.assumeIsolated {
            self.audio.notifyDidDeactivate(audioSession)
            self.audio.setAudioEnabled(false)
        }
    }
}
