import XCTest
@testable import pqp

/// The notification and pending-invite decisions, pinned.
///
/// Three rules live here, and all three fail in ways nobody reports as a bug.
/// A banner drawn over the message it announces just looks cheap. A permission
/// prompt at the wrong moment is declined once and permanently, with no second
/// chance the app can ask for. And a pending invite consumed twice re-joins on
/// every launch, or consumed zero times loses the reason somebody installed the
/// app at all.
final class PushNotificationTests: XCTestCase {
    private func makeDefaults(_ name: String = #function) -> UserDefaults {
        let suite = "pqp.tests.\(name).\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return defaults
    }

    // MARK: - Foreground presentation

    func testNoBannerOverTheConversationYouAreReading() {
        XCTAssertFalse(
            PushPresentation.shouldInterrupt(
                path: "/app/dm/chan-1", visibleChannelId: "chan-1"
            )
        )
        XCTAssertFalse(
            PushPresentation.shouldInterrupt(
                path: "/app/server/srv-1/channel/chan-1", visibleChannelId: "chan-1"
            )
        )
    }

    func testABannerForEverySomewhereElse() {
        XCTAssertTrue(
            PushPresentation.shouldInterrupt(
                path: "/app/dm/chan-2", visibleChannelId: "chan-1"
            )
        )
        // Same channel id, different server, is still a different channel — but
        // channel ids are globally unique, so what this really pins is that the
        // *channel* is compared and not the server.
        XCTAssertTrue(
            PushPresentation.shouldInterrupt(
                path: "/app/server/srv-2/channel/chan-2", visibleChannelId: "chan-1"
            )
        )
    }

    func testABannerWhenNothingIsOnScreen() {
        // On the hub, in settings, in a call: nothing to be redundant with.
        XCTAssertTrue(
            PushPresentation.shouldInterrupt(path: "/app/dm/chan-1", visibleChannelId: nil)
        )
    }

    /// A payload whose path is missing or unrecognised still gets a banner. The
    /// alternative — swallowing anything not understood — turns a server-side
    /// route change into notifications that arrive and are never shown.
    func testAnUnreadablePayloadStillInterrupts() {
        XCTAssertTrue(
            PushPresentation.shouldInterrupt(path: nil, visibleChannelId: "chan-1")
        )
        XCTAssertTrue(
            PushPresentation.shouldInterrupt(path: "/app", visibleChannelId: "chan-1")
        )
        XCTAssertTrue(
            PushPresentation.shouldInterrupt(
                path: "/app/something/new", visibleChannelId: "chan-1"
            )
        )
    }

    // MARK: - When to ask

    func testTheExplainerIsOfferedOnlyOnceAndOnlyWhenSignedIn() {
        // The whole point: not on the splash, not during onboarding, not behind
        // the age gate — after a real sign-in has landed.
        for phase in [SessionPhase.loading, .onboarding, .ageGate, .blocked] {
            XCTAssertFalse(
                PushPermission.shouldOfferExplainer(
                    phase: phase, serverSupportsApns: true, hasAsked: false
                ),
                "should not ask during \(phase)"
            )
        }
        XCTAssertTrue(
            PushPermission.shouldOfferExplainer(
                phase: .ready, serverSupportsApns: true, hasAsked: false
            )
        )
        // Asked once is asked forever: the system dialog only ever appears once
        // and a refusal cannot be re-prompted, so re-offering the explainer only
        // teaches people to dismiss it.
        XCTAssertFalse(
            PushPermission.shouldOfferExplainer(
                phase: .ready, serverSupportsApns: true, hasAsked: true
            )
        )
    }

    /// A deployment with no APNs key can never deliver a notification. Asking
    /// anyway would burn the one prompt this install gets for nothing.
    func testNothingIsAskedWhenTheServerCannotSend() {
        XCTAssertFalse(
            PushPermission.shouldOfferExplainer(
                phase: .ready, serverSupportsApns: false, hasAsked: false
            )
        )
    }

    func testTheAskedFlagPersists() {
        let defaults = makeDefaults()
        XCTAssertFalse(PushPermission.hasAsked(defaults))
        PushPermission.markAsked(defaults)
        XCTAssertTrue(PushPermission.hasAsked(defaults))
    }

    // MARK: - Pending invites

    func testAPendingInviteSurvivesUntilItIsConsumed() {
        let defaults = makeDefaults()
        PendingInvite.stash("AB12CD34", to: defaults)

        // Peeking is free and repeatable — a view may want to say "you'll join
        // after signing in" while the sheet is still up.
        XCTAssertEqual(PendingInvite.peek(from: defaults), "AB12CD34")
        XCTAssertEqual(PendingInvite.peek(from: defaults), "AB12CD34")

        XCTAssertEqual(PendingInvite.consume(from: defaults), "AB12CD34")
    }

    /// The ordering rule. Consumption happens once, on the first landing at
    /// `.ready`; a second landing (a re-sign-in, a background/foreground cycle
    /// that re-runs the phase change) must find nothing.
    func testConsumingIsIdempotentSoALaunchNeverRejoins() {
        let defaults = makeDefaults()
        PendingInvite.stash("CODE1", to: defaults)

        XCTAssertEqual(PendingInvite.consume(from: defaults), "CODE1")
        XCTAssertNil(PendingInvite.consume(from: defaults))
        XCTAssertNil(PendingInvite.peek(from: defaults))
    }

    /// Two links before sign-in completes: the newest tap is the intent, and
    /// only one of them can be "the invite they just followed".
    func testASecondInviteReplacesTheFirst() {
        let defaults = makeDefaults()
        PendingInvite.stash("FIRST1", to: defaults)
        PendingInvite.stash("SECOND", to: defaults)
        XCTAssertEqual(PendingInvite.consume(from: defaults), "SECOND")
        XCTAssertNil(PendingInvite.consume(from: defaults))
    }

    func testNothingUsableIsNotStashed() {
        let defaults = makeDefaults()
        PendingInvite.stash("", to: defaults)
        XCTAssertNil(PendingInvite.peek(from: defaults))
        PendingInvite.stash("   \n", to: defaults)
        XCTAssertNil(PendingInvite.peek(from: defaults))
        PendingInvite.stash(
            String(repeating: "a", count: DeepLink.maxInviteCodeLength + 1),
            to: defaults
        )
        XCTAssertNil(PendingInvite.peek(from: defaults))
    }

    func testClearingLeavesNothingForTheNextAccount() {
        let defaults = makeDefaults()
        PendingInvite.stash("CODE1", to: defaults)
        PendingInvite.clear(from: defaults)
        XCTAssertNil(PendingInvite.peek(from: defaults))
    }

    /// A stashed code is whitespace-trimmed on the way in, so the join request
    /// cannot carry a trailing newline from a paste.
    func testAStashedCodeIsTrimmed() {
        let defaults = makeDefaults()
        PendingInvite.stash("  AB12CD34\n", to: defaults)
        XCTAssertEqual(PendingInvite.consume(from: defaults), "AB12CD34")
    }
}
