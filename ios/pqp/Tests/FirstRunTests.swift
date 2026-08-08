import XCTest

@testable import pqp

/// The first-run checklist's rules, without a simulator.
///
/// The mirror of `client/src/lib/first-run.test.ts`. Both platforms read the same
/// server preference, so a disagreement about when the card shows or when it is
/// answered would be visible to a user as a card they dismissed on their phone
/// still sitting on their laptop. Keeping both suites on the same cases is what
/// stops one drifting.
final class FirstRunTests: XCTestCase {
    private func nothingDone() -> FirstRun.Inputs {
        FirstRun.Inputs(
            avatarURL: nil,
            serverCount: 0,
            friendCount: 0,
            preferences: UserPreferences()
        )
    }

    private func dismissed() -> UserPreferences {
        var preferences = UserPreferences()
        preferences.firstRunDismissedAt = "2026-08-02T00:00:00.000Z"
        return preferences
    }

    // MARK: - state

    func testAllThreeAreOutstandingForAnAccountThatHasJustSignedUp() {
        let state = FirstRun.state(nothingDone())
        XCTAssertEqual(state.tasks.map(\.task), [.server, .friend, .avatar])
        XCTAssertTrue(state.tasks.allSatisfy { !$0.done })
        XCTAssertFalse(state.complete)
    }

    func testOneServerTicksTheServerRowHoweverTheyGotIt() {
        var inputs = nothingDone()
        inputs.serverCount = 1
        let state = FirstRun.state(inputs)
        XCTAssertTrue(state.isDone(.server))
        XCTAssertFalse(state.isDone(.friend))
        XCTAssertFalse(state.complete)
    }

    func testOneFriendTicksTheFriendRow() {
        var inputs = nothingDone()
        inputs.friendCount = 1
        XCTAssertTrue(FirstRun.state(inputs).isDone(.friend))
    }

    func testAStoredAvatarURLTicksTheAvatarRow() {
        var inputs = nothingDone()
        inputs.avatarURL = "https://example.test/a.png"
        XCTAssertTrue(FirstRun.state(inputs).isDone(.avatar))
    }

    func testAnEmptyAvatarStringIsNotAFace() {
        // A cleared field has round-tripped as "" rather than null, and ticking
        // that box would credit somebody for an avatar nobody can see.
        var inputs = nothingDone()
        inputs.avatarURL = ""
        XCTAssertFalse(FirstRun.state(inputs).isDone(.avatar))
    }

    func testItIsCompleteOnlyWhenAllThreeAre() {
        let inputs = FirstRun.Inputs(
            avatarURL: "https://example.test/a.png",
            serverCount: 2,
            friendCount: 3,
            preferences: UserPreferences()
        )
        XCTAssertTrue(FirstRun.state(inputs).complete)
    }

    // MARK: - shouldShow

    func testItOffersTheCardToAnAccountWithNothingDone() {
        XCTAssertTrue(FirstRun.shouldShow(nothingDone()))
    }

    func testItOffersTheCardWhileOnlySomeOfTheThreeAreOutstanding() {
        var inputs = nothingDone()
        inputs.serverCount = 1
        XCTAssertTrue(FirstRun.shouldShow(inputs))
    }

    func testItNeverOffersTheCardAgainOnceDismissed() {
        var inputs = nothingDone()
        inputs.preferences = dismissed()
        XCTAssertFalse(FirstRun.shouldShow(inputs))
    }

    func testAnEmptyStampCountsAsNeverDismissedWhichIsTheOnlyWayToReArmIt() {
        // Preferences are one JSONB blob merged with `||` server-side, so a key can
        // be overwritten but never removed — once this field is written there is no
        // way back to absent. Reading "" as "never dismissed" is the only re-arm
        // there is, and it is what makes the flag testable at all. The web gets
        // this free from JavaScript truthiness; Swift has to mean it.
        var inputs = nothingDone()
        var preferences = UserPreferences()
        preferences.firstRunDismissedAt = ""
        inputs.preferences = preferences
        XCTAssertFalse(FirstRun.isDismissed(preferences))
        XCTAssertTrue(FirstRun.shouldShow(inputs))
    }

    func testItDoesNotOfferACardWhosePreferencesHaveNotLoaded() {
        // Nil is not "no dismissal recorded" — it is "we have not read the blob
        // yet". Offering here would flash the card up and hide it again, and on an
        // API with no preference store at all it would mean a card whose "no
        // thanks" never sticks.
        var inputs = nothingDone()
        inputs.preferences = nil
        XCTAssertFalse(FirstRun.shouldShow(inputs))
    }

    func testItDoesNotOfferTheCardOnceEverythingIsDone() {
        let inputs = FirstRun.Inputs(
            avatarURL: "https://example.test/a.png",
            serverCount: 1,
            friendCount: 1,
            preferences: UserPreferences()
        )
        XCTAssertFalse(FirstRun.shouldShow(inputs))
    }

    // MARK: - shouldStampComplete

    func testItStampsOnceEverythingIsDoneSoItCanNeverComeBack() {
        // Visibility is derived from live state, and live state comes back.
        // Leaving your last server a year from now must not reopen a "get into a
        // server" nudge at somebody who has been here a year.
        let inputs = FirstRun.Inputs(
            avatarURL: "https://example.test/a.png",
            serverCount: 1,
            friendCount: 1,
            preferences: UserPreferences()
        )
        XCTAssertTrue(FirstRun.shouldStampComplete(inputs))
    }

    func testItDoesNotStampWhileSomethingIsOutstanding() {
        XCTAssertFalse(FirstRun.shouldStampComplete(nothingDone()))
        var partial = nothingDone()
        partial.serverCount = 1
        XCTAssertFalse(FirstRun.shouldStampComplete(partial))
    }

    func testItDoesNotStampTwice() {
        var inputs = FirstRun.Inputs(
            avatarURL: "https://example.test/a.png",
            serverCount: 1,
            friendCount: 1,
            preferences: UserPreferences()
        )
        inputs.preferences = dismissed()
        XCTAssertFalse(FirstRun.shouldStampComplete(inputs))
    }

    func testItDoesNotStampWhenThereIsNoPreferenceStoreToStamp() {
        var inputs = FirstRun.Inputs(
            avatarURL: "https://example.test/a.png",
            serverCount: 1,
            friendCount: 1,
            preferences: UserPreferences()
        )
        inputs.preferences = nil
        XCTAssertFalse(FirstRun.shouldStampComplete(inputs))
    }

    // MARK: - the stamp itself

    func testTheStampIsISO8601WithAZSoTheWebReadsItBack() {
        // Both platforms write this field and both read it. The server validates
        // nothing — `onboardedAt` and this are bare strings in the Zod schema — so
        // the format has to be pinned here rather than left to whatever
        // `Date.description` produces.
        let stamp = FirstRun.dismissedStamp(Date(timeIntervalSince1970: 0))
        XCTAssertEqual(stamp, "1970-01-01T00:00:00.000Z")
    }

    func testTheStampRoundTripsThroughTheWireModel() {
        var preferences = UserPreferences()
        preferences.firstRunDismissedAt = FirstRun.dismissedStamp()
        let encoded = try! JSONEncoder().encode(preferences)
        let decoded = try! JSONDecoder().decode(UserPreferences.self, from: encoded)
        XCTAssertEqual(decoded.firstRunDismissedAt, preferences.firstRunDismissedAt)
    }

    func testTheFieldIsAbsentFromTheWireWhenNobodyHasDismissedAnything() {
        // Preferences merge shallowly server-side and a key can never be removed,
        // so encoding this as `null` rather than omitting it would write a key
        // that reads as "present" to anything checking for absence.
        let encoded = try! JSONEncoder().encode(UserPreferences())
        let json = String(data: encoded, encoding: .utf8)!
        XCTAssertFalse(json.contains("firstRunDismissedAt"))
    }
}
