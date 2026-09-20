import XCTest
import CallKit
import AVFoundation
@testable import pqp

/// `CallKitCoordinator`'s bookkeeping, pinned with the real `CXProvider` and
/// `CXCallController` swapped for fakes behind `CXProviding` and
/// `CXCallControllerProviding`. A test bundle has no telephony entitlement
/// to register a call with the system for real, so this is the only way to
/// exercise the state machine at all.
///
/// The CallKit audio handshake (`provider(_:didActivate:)` / `didDeactivate`
/// and the CallKit-refused fallback) is covered too, since it turned out to
/// carry real logic and not just a pass-through: with `useManualAudio` on, the
/// coordinator must ALSO enable WebRTC's audio unit, and omitting that left
/// every CallKit-carried call silent in both directions while video worked.
/// A fake `WebRTCAudioControlling` records the handshake so the assertion runs
/// without touching the real `RTCAudioSession` singleton.
final class CallKitCoordinatorTests: XCTestCase {
    @MainActor
    private func makeCoordinator() -> (
        coordinator: CallKitCoordinator, provider: FakeCXProvider, controller: FakeCXCallController
    ) {
        let provider = FakeCXProvider()
        let controller = FakeCXCallController()
        let coordinator = CallKitCoordinator(provider: provider, callController: controller)
        return (coordinator, provider, controller)
    }

    /// As `makeCoordinator`, plus a fake audio control so the CallKit audio
    /// handshake can be observed.
    @MainActor
    private func makeAudioCoordinator() -> (
        coordinator: CallKitCoordinator, provider: FakeCXProvider,
        controller: FakeCXCallController, audio: FakeWebRTCAudioControl
    ) {
        let provider = FakeCXProvider()
        let controller = FakeCXCallController()
        let audio = FakeWebRTCAudioControl()
        let coordinator = CallKitCoordinator(
            provider: provider, callController: controller, audio: audio
        )
        return (coordinator, provider, controller, audio)
    }

    // MARK: - Outgoing

    @MainActor
    func testReportOutgoingCallRequestsAStartActionThenReportsConnecting() {
        let (coordinator, provider, controller) = makeCoordinator()
        coordinator.reportOutgoingCall(room: .conversation("c1"), displayName: "Bob")
        XCTAssertEqual(controller.requestedActions.count, 1)
        XCTAssertTrue(controller.requestedActions.first is CXStartCallAction)
        XCTAssertEqual(provider.startedConnecting.count, 1)
    }

    /// Two different rooms are two different calls, each with its own UUID:
    /// the whole reason a room is looked up by UUID rather than assumed.
    @MainActor
    func testEachRoomGetsItsOwnCallUUID() {
        let (coordinator, _, controller) = makeCoordinator()
        coordinator.reportOutgoingCall(room: .conversation("c1"), displayName: "Bob")
        coordinator.reportOutgoingCall(room: .channel("ch1"), displayName: "#general")
        let uuids = controller.requestedActions.compactMap { ($0 as? CXStartCallAction)?.callUUID }
        XCTAssertEqual(uuids.count, 2)
        XCTAssertNotEqual(uuids[0], uuids[1])
    }

    /// A second report for a room already reporting is a no-op: `start()`
    /// already guards a live call, this is the defensive belt.
    @MainActor
    func testReportOutgoingCallIsNotSentTwiceForTheSameRoom() {
        let (coordinator, _, controller) = makeCoordinator()
        coordinator.reportOutgoingCall(room: .conversation("c1"), displayName: "Bob")
        coordinator.reportOutgoingCall(room: .conversation("c1"), displayName: "Bob")
        XCTAssertEqual(controller.requestedActions.count, 1)
    }

    /// CallKit refusing the registration must not strand the room: it is
    /// forgotten so a later attempt (or a plain hang-up) is not blocked by a
    /// mapping to a call CallKit never actually holds.
    @MainActor
    func testAFailedOutgoingReportForgetsTheRoom() {
        let (coordinator, _, controller) = makeCoordinator()
        controller.nextError = NSError(domain: "test", code: 1)
        coordinator.reportOutgoingCall(room: .conversation("c1"), displayName: "Bob")
        controller.nextError = nil
        coordinator.reportOutgoingCall(room: .conversation("c1"), displayName: "Bob")
        XCTAssertEqual(controller.requestedActions.count, 2)
    }

    // MARK: - Incoming

    @MainActor
    func testReportIncomingCallTellsTheSystemProvider() {
        let (coordinator, provider, _) = makeCoordinator()
        coordinator.reportIncomingCall(room: .conversation("c1"), callerName: "Alice")
        XCTAssertEqual(provider.newIncomingCalls.count, 1)
        XCTAssertEqual(provider.newIncomingCalls.first?.update.localizedCallerName, "Alice")
    }

    @MainActor
    func testReportIncomingCallIsNotSentTwiceForTheSameRoom() {
        let (coordinator, provider, _) = makeCoordinator()
        coordinator.reportIncomingCall(room: .conversation("c1"), callerName: "Alice")
        coordinator.reportIncomingCall(room: .conversation("c1"), callerName: "Alice")
        XCTAssertEqual(provider.newIncomingCalls.count, 1)
    }

    /// A successful report tells the caller CallKit is presenting the ring, so
    /// the room owner suppresses its own in-app banner: no double ring.
    @MainActor
    func testReportIncomingCallReportsPresentedOnSuccess() {
        let (coordinator, _, _) = makeCoordinator()
        var presented: Bool?
        coordinator.reportIncomingCall(room: .conversation("c1"), callerName: "Alice") {
            presented = $0
        }
        XCTAssertEqual(presented, true)
    }

    /// CallKit refusing the report must tell the caller it is NOT presenting,
    /// so the in-app banner takes over as the fallback ring rather than the
    /// call ringing nowhere at all.
    @MainActor
    func testReportIncomingCallReportsNotPresentedWhenCallKitRefuses() {
        let (coordinator, provider, _) = makeCoordinator()
        provider.nextIncomingError = NSError(domain: "test", code: 1)
        var presented: Bool?
        coordinator.reportIncomingCall(room: .conversation("c1"), callerName: "Alice") {
            presented = $0
        }
        XCTAssertEqual(presented, false)
        // Forgotten too, so a later real report for the same room is not
        // deduplicated away against a call CallKit never actually held.
        provider.nextIncomingError = nil
        coordinator.reportIncomingCall(room: .conversation("c1"), callerName: "Alice")
        XCTAssertEqual(provider.newIncomingCalls.count, 2)
    }

    /// A room already reported still counts as presented, so a duplicate ring
    /// frame does not un-suppress the in-app banner mid-ring.
    @MainActor
    func testReportIncomingCallReportsPresentedForAnAlreadyReportedRoom() {
        let (coordinator, _, _) = makeCoordinator()
        coordinator.reportIncomingCall(room: .conversation("c1"), callerName: "Alice")
        var presented: Bool?
        coordinator.reportIncomingCall(room: .conversation("c1"), callerName: "Alice") {
            presented = $0
        }
        XCTAssertEqual(presented, true)
    }

    // MARK: - Connected

    @MainActor
    func testReportConnectedOnlyOnceForTheSameRoom() {
        let (coordinator, provider, _) = makeCoordinator()
        coordinator.reportOutgoingCall(room: .conversation("c1"), displayName: "Bob")
        coordinator.reportConnected(room: .conversation("c1"))
        coordinator.reportConnected(room: .conversation("c1"))
        XCTAssertEqual(provider.connectedAt.count, 1)
    }

    /// A room CallKit never heard about (a failed report, or a typo) has
    /// nothing to mark connected.
    @MainActor
    func testReportConnectedForAnUnknownRoomDoesNothing() {
        let (coordinator, provider, _) = makeCoordinator()
        coordinator.reportConnected(room: .conversation("ghost"))
        XCTAssertTrue(provider.connectedAt.isEmpty)
    }

    // MARK: - Ended (app-initiated)

    @MainActor
    func testReportCallEndedForgetsTheRoomSoASecondCallIsANoOp() {
        let (coordinator, provider, _) = makeCoordinator()
        coordinator.reportOutgoingCall(room: .conversation("c1"), displayName: "Bob")
        coordinator.reportCallEnded(room: .conversation("c1"), reason: .remoteEnded)
        coordinator.reportCallEnded(room: .conversation("c1"), reason: .remoteEnded)
        XCTAssertEqual(provider.endedCalls.count, 1)
        XCTAssertEqual(provider.endedCalls.first?.reason, .remoteEnded)
    }

    @MainActor
    func testReportCallEndedForAnUnknownRoomDoesNothing() {
        let (coordinator, provider, _) = makeCoordinator()
        coordinator.reportCallEnded(room: .conversation("ghost"), reason: .failed)
        XCTAssertTrue(provider.endedCalls.isEmpty)
    }

    // MARK: - CXProviderDelegate: system → app

    @MainActor
    func testSystemAnswerRoutesToTheConversationDelegateAndFulfills() {
        let (coordinator, provider, _) = makeCoordinator()
        let calls = FakeRoomHandler()
        let channels = FakeRoomHandler()
        coordinator.callDelegate = calls
        coordinator.channelDelegate = channels
        coordinator.reportIncomingCall(room: .conversation("c1"), callerName: "Alice")
        let uuid = provider.newIncomingCalls[0].uuid

        let action = CXAnswerCallAction(call: uuid)
        coordinator.provider(CXProvider(configuration: .pqp), perform: action)

        XCTAssertEqual(calls.answered, [.conversation("c1")])
        XCTAssertTrue(channels.answered.isEmpty)
        // `action.isComplete` is not asserted: a `CXAction` built standalone,
        // outside a transaction a real `CXCallController` requested, does not
        // reliably flip that flag on `fulfill()`/`fail()` in this
        // environment. What matters, and is asserted above, is that the
        // coordinator resolves the action's UUID to the right room and hands
        // it to the right delegate; `fulfill()`/`fail()` running with no
        // throw is the rest of the contract this test can prove.
    }

    /// A stray or late action for a UUID this coordinator no longer knows
    /// (the call already ended) must fail rather than hand a made-up room to
    /// a delegate.
    @MainActor
    func testSystemAnswerForAnUnknownUUIDFails() {
        let (coordinator, _, _) = makeCoordinator()
        let callDelegate = FakeRoomHandler()
        coordinator.callDelegate = callDelegate
        let action = CXAnswerCallAction(call: UUID())
        coordinator.provider(CXProvider(configuration: .pqp), perform: action)
        XCTAssertTrue(callDelegate.answered.isEmpty)
    }

    @MainActor
    func testSystemEndRoutesToTheChannelDelegateAndForgetsTheRoomFirst() {
        let (coordinator, _, controller) = makeCoordinator()
        let channels = FakeRoomHandler()
        coordinator.channelDelegate = channels
        coordinator.reportOutgoingCall(room: .channel("ch1"), displayName: "#general")
        let uuid = (controller.requestedActions.first as? CXStartCallAction)?.callUUID

        let action = CXEndCallAction(call: uuid!)
        coordinator.provider(CXProvider(configuration: .pqp), perform: action)

        XCTAssertEqual(channels.ended, [.channel("ch1")])
        // The mapping was forgotten before `channels.ended` was even called,
        // so the room owner's own app-side `reportCallEnded`, called moments
        // later by `leave()`/`hangUp()`, finds nothing left to report.
        // (`FakeCXProvider.endedCalls` stays empty: a system-initiated end
        // never calls `reportCall(endedAt:)` on the way out either.)
    }

    @MainActor
    func testSystemMuteRoutesToTheRightRoomWithTheRightValue() {
        let (coordinator, provider, _) = makeCoordinator()
        let calls = FakeRoomHandler()
        coordinator.callDelegate = calls
        coordinator.reportIncomingCall(room: .conversation("c1"), callerName: "Alice")
        let uuid = provider.newIncomingCalls[0].uuid

        let action = CXSetMutedCallAction(call: uuid, muted: true)
        coordinator.provider(CXProvider(configuration: .pqp), perform: action)

        XCTAssertEqual(calls.muted.count, 1)
        XCTAssertEqual(calls.muted.first?.0, .conversation("c1"))
        XCTAssertEqual(calls.muted.first?.1, true)
    }

    @MainActor
    func testProviderDidResetEndsEveryKnownRoomAndClearsTheMap() {
        let (coordinator, provider, controller) = makeCoordinator()
        let calls = FakeRoomHandler()
        let channels = FakeRoomHandler()
        coordinator.callDelegate = calls
        coordinator.channelDelegate = channels
        coordinator.reportOutgoingCall(room: .conversation("c1"), displayName: "Bob")
        coordinator.reportOutgoingCall(room: .channel("ch1"), displayName: "#general")

        coordinator.providerDidReset(CXProvider(configuration: .pqp))

        XCTAssertEqual(calls.ended, [.conversation("c1")])
        XCTAssertEqual(channels.ended, [.channel("ch1")])
        // Forgotten, not just ended: a report against either room afterward
        // is a no-op rather than a call CallKit no longer knows about.
        coordinator.reportConnected(room: .conversation("c1"))
        XCTAssertTrue(provider.connectedAt.isEmpty)
    }

    // MARK: - CallKit audio handshake (the DM-call silence bug)

    /// The regression this seam exists for. A DM call is mesh WebRTC wrapped
    /// in CallKit; with `useManualAudio` armed at init, the call becomes
    /// audible only when the coordinator, on CallKit activating the session,
    /// both notifies WebRTC (`notifyDidActivate`) AND enables the audio unit
    /// (`setAudioEnabled(true)`). The bug did only the first, so the VoIP unit
    /// never started and the call was silent in both directions while video
    /// (which needs no audio unit) worked. This asserts the second step.
    ///
    /// It fails against the bug: drop `setAudioEnabled(true)` from
    /// `provider(_:didActivate:)` and `audio.audioEnabled` stays false here.
    @MainActor
    func testCallKitActivationEnablesWebRTCAudio() {
        let (coordinator, _, _, audio) = makeAudioCoordinator()
        // Manual audio is armed at init; nothing has enabled the unit yet.
        XCTAssertTrue(audio.manualAudioEnabled)
        XCTAssertFalse(audio.audioEnabled)

        // The outgoing DM ring, then CallKit activating the audio session.
        coordinator.reportOutgoingCall(room: .conversation("c1"), displayName: "Bob")
        coordinator.provider(
            CXProvider(configuration: .pqp), didActivate: AVAudioSession.sharedInstance()
        )

        XCTAssertEqual(audio.didActivateCount, 1)
        XCTAssertTrue(
            audio.audioEnabled,
            "WebRTC audio must be enabled after CallKit activates the session, or the call is silent"
        )
    }

    /// The mirror: CallKit deactivating the session stops the audio unit, so
    /// it is not left running against a session CallKit has torn down.
    @MainActor
    func testCallKitDeactivationDisablesWebRTCAudio() {
        let (coordinator, _, _, audio) = makeAudioCoordinator()
        coordinator.provider(
            CXProvider(configuration: .pqp), didActivate: AVAudioSession.sharedInstance()
        )
        XCTAssertTrue(audio.audioEnabled)

        coordinator.provider(
            CXProvider(configuration: .pqp), didDeactivate: AVAudioSession.sharedInstance()
        )
        XCTAssertEqual(audio.didDeactivateCount, 1)
        XCTAssertFalse(audio.audioEnabled)
    }

    /// CallKit refusing the registration falls back to activating the session
    /// directly, and that path must enable the audio unit too, the same second
    /// step as the CallKit path, or a refused report is silent rather than
    /// merely missing its lock-screen card.
    @MainActor
    func testCallKitRefusalFallbackEnablesWebRTCAudio() {
        let (coordinator, _, controller, audio) = makeAudioCoordinator()
        controller.nextError = NSError(domain: "test", code: 1)
        coordinator.reportOutgoingCall(room: .conversation("c1"), displayName: "Bob")

        XCTAssertEqual(audio.directActivations, 1)
        XCTAssertTrue(audio.audioEnabled)
    }
}

// MARK: - Fakes

@MainActor
private final class FakeCXProvider: CXProviding {
    private(set) var delegateWasSet = false
    private(set) var newIncomingCalls: [(uuid: UUID, update: CXCallUpdate)] = []
    private(set) var endedCalls: [(uuid: UUID, reason: CXCallEndedReason)] = []
    private(set) var startedConnecting: [UUID] = []
    private(set) var connectedAt: [UUID] = []
    /// Set before a call to `reportNewIncomingCall`; consumed by it so a
    /// later, unrelated report is not silently refused too.
    var nextIncomingError: Error?

    func setDelegate(_ delegate: CXProviderDelegate) {
        delegateWasSet = true
    }

    func reportNewIncomingCall(
        uuid: UUID, update: CXCallUpdate, completion: @escaping (Error?) -> Void
    ) {
        newIncomingCalls.append((uuid, update))
        let error = nextIncomingError
        nextIncomingError = nil
        completion(error)
    }

    func reportCallEnded(uuid: UUID, at date: Date, reason: CXCallEndedReason) {
        endedCalls.append((uuid, reason))
    }

    func reportOutgoingCallStartedConnecting(uuid: UUID, at date: Date) {
        startedConnecting.append(uuid)
    }

    func reportOutgoingCallConnected(uuid: UUID, at date: Date) {
        connectedAt.append(uuid)
    }
}

@MainActor
private final class FakeCXCallController: CXCallControllerProviding {
    private(set) var requestedActions: [CXAction] = []
    /// Set before a call to `request`; consumed by it, the same reason
    /// `FakeCXProvider.nextIncomingError` is.
    var nextError: Error?

    func request(_ transaction: CXTransaction, completion: @escaping (Error?) -> Void) {
        requestedActions.append(contentsOf: transaction.actions)
        let error = nextError
        nextError = nil
        completion(error)
    }
}

/// Records the CallKit audio handshake in place of the real, process-wide
/// `RTCAudioSession`. `audioEnabled` is the property the DM-call silence bug
/// turned on: it must end true after CallKit activates the session.
@MainActor
private final class FakeWebRTCAudioControl: WebRTCAudioControlling {
    private(set) var manualAudioEnabled = false
    private(set) var audioEnabled = false
    private(set) var didActivateCount = 0
    private(set) var didDeactivateCount = 0
    private(set) var directActivations = 0

    func enableManualAudio() { manualAudioEnabled = true }
    func notifyDidActivate(_ session: AVAudioSession) { didActivateCount += 1 }
    func notifyDidDeactivate(_ session: AVAudioSession) { didDeactivateCount += 1 }
    func setAudioEnabled(_ enabled: Bool) { audioEnabled = enabled }
    func activateSessionDirectly() { directActivations += 1 }
}

@MainActor
private final class FakeRoomHandler: CallKitRoomHandling {
    private(set) var answered: [CallKitRoom] = []
    private(set) var ended: [CallKitRoom] = []
    private(set) var muted: [(CallKitRoom, Bool)] = []

    func callKitAnswer(_ room: CallKitRoom) { answered.append(room) }
    func callKitEnd(_ room: CallKitRoom) { ended.append(room) }
    func callKitSetMuted(_ room: CallKitRoom, muted isMuted: Bool) { muted.append((room, isMuted)) }
}
