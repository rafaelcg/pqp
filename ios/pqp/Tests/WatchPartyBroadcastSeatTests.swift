import XCTest
@testable import pqp

/**
 A watch party is a broadcast, not a call (owner, 2026-09-26; `docs/WATCH_PARTY.md`
 "Nobody watching is ever asked for a microphone" and "A watch party has no
 voice by default"). Three decisions carry that on iOS, and each is pinned
 here as a pure function:

 1. whether a join publishes a microphone (`SeatMicrophone` and friends);
 2. which words a failure in the room is described in (`SfuRoomKind`);
 3. what the stage above the transcript offers a host before any seat
    (`watchPartyStageHostCard`).
 */
final class WatchPartyBroadcastSeatTests: XCTestCase {

    // MARK: - Whether this join publishes a microphone

    /// Voice off is the default and asks nobody for anything; voice on joins
    /// muted, as the web's go-live seats its host.
    func testTheHostSeatFollowsThePartysVoiceOption() {
        XCTAssertEqual(watchPartyHostSeatMicrophone(voiceEnabled: false), .none)
        XCTAssertEqual(watchPartyHostSeatMicrophone(voiceEnabled: true), .startMuted)
    }

    /// Only a seat that will publish asks for the record permission.
    func testOnlyAPublishingSeatAsksForThePermission() {
        XCTAssertTrue(seatAsksForMicrophone(.standard))
        XCTAssertTrue(seatAsksForMicrophone(.startMuted))
        XCTAssertFalse(seatAsksForMicrophone(.none))
    }

    /// A refusal ends an ordinary voice join, as it always has, and never a
    /// broadcast: the host goes live with no microphone instead.
    func testARefusedPermissionFailsACallButNeverABroadcast() {
        XCTAssertEqual(seatMicrophoneAfterPermission(.standard, granted: false), .refuseJoin)
        XCTAssertEqual(seatMicrophoneAfterPermission(.startMuted, granted: false), .proceed(.none))
        XCTAssertEqual(seatMicrophoneAfterPermission(.none, granted: false), .proceed(.none))
        for seat in [SeatMicrophone.standard, .startMuted, .none] {
            XCTAssertEqual(seatMicrophoneAfterPermission(seat, granted: true), .proceed(seat))
        }
    }

    /// An ordinary join follows "mute when joining"; a broadcast seat is
    /// muted from its first packet whatever that setting says.
    func testABroadcastSeatIsAlwaysMutedFromTheStart() {
        XCTAssertFalse(seatStartsMuted(.standard, muteOnJoinPreference: false))
        XCTAssertTrue(seatStartsMuted(.standard, muteOnJoinPreference: true))
        for preference in [false, true] {
            XCTAssertTrue(seatStartsMuted(.startMuted, muteOnJoinPreference: preference))
            XCTAssertTrue(seatStartsMuted(.none, muteOnJoinPreference: preference))
        }
    }

    /// The SFU join publishes only for a seat that has a microphone and a
    /// room rule that lets it speak. No SPEAK publishes nothing whatever the
    /// seat asked for; a seat with no microphone publishes nothing even with it.
    func testTheSfuJoinPublishesOnlyASpeakingSeatWithAMicrophone() {
        XCTAssertTrue(sfuJoinPublishesMicrophone(seat: .standard, canSpeak: true))
        XCTAssertTrue(sfuJoinPublishesMicrophone(seat: .startMuted, canSpeak: true))
        XCTAssertFalse(sfuJoinPublishesMicrophone(seat: .none, canSpeak: true))
        for seat in [SeatMicrophone.standard, .startMuted, .none] {
            XCTAssertFalse(sfuJoinPublishesMicrophone(seat: seat, canSpeak: false))
        }
    }

    /// Farol on #843: a host who took an ordinary seat through Join, then
    /// created and went live with voice off, kept an unmuted microphone,
    /// because the same-room join returned before the policy was applied.
    func testABroadcastJoinOnAnExistingSeatMutesIt() {
        let reopened = reopenedSeatMicrophone(current: .standard, requested: .none)
        XCTAssertEqual(reopened.seat, .startMuted)
        XCTAssertTrue(reopened.mute)
        let voiceOn = reopenedSeatMicrophone(current: .standard, requested: .startMuted)
        XCTAssertEqual(voiceOn.seat, .startMuted)
        XCTAssertTrue(voiceOn.mute)
        let alreadyNone = reopenedSeatMicrophone(current: .none, requested: .none)
        XCTAssertEqual(alreadyNone.seat, .none)
        XCTAssertTrue(alreadyNone.mute)
    }

    /// An ordinary reopen (the stage reopened, a second Join tap) changes nothing.
    func testAnOrdinaryReopenLeavesTheSeatAlone() {
        for current in [SeatMicrophone.standard, .startMuted, .none] {
            let reopened = reopenedSeatMicrophone(current: current, requested: .standard)
            XCTAssertEqual(reopened.seat, current)
            XCTAssertFalse(reopened.mute)
        }
    }

    // MARK: - The party's voice option, off the wire

    private func decodeParty(options: String?) throws -> WatchPartyPayload {
        let optionsField = options.map { #","options":\#($0)"# } ?? ""
        let json = """
        {"id":"p1","channelId":"c1","name":"Sessão","state":"draft",
         "hostUserId":"u1","hostDisplayName":"Rafael","viewerRole":"host"\(optionsField)}
        """
        return try JSONDecoder().decode(WatchPartyPayload.self, from: Data(json.utf8))
    }

    func testVoiceIsOffWhenThePartyCarriesNoOptions() throws {
        XCTAssertFalse(try decodeParty(options: nil).voiceEnabled)
        XCTAssertFalse(try decodeParty(options: "{}").voiceEnabled)
    }

    func testVoiceEnabledIsReadWhenPresent() throws {
        XCTAssertTrue(try decodeParty(options: #"{"voiceEnabled":true,"guests":"off"}"#).voiceEnabled)
        XCTAssertFalse(try decodeParty(options: #"{"voiceEnabled":false,"guests":"invite"}"#).voiceEnabled)
    }

    /// A payload with only `guests` reads it the way the server's own table
    /// does (`deriveLegacyWatchPartyVoiceTriple`): `off` is no voice.
    func testGuestsAloneDecidesVoiceWhenVoiceEnabledIsMissing() throws {
        XCTAssertFalse(try decodeParty(options: #"{"guests":"off"}"#).voiceEnabled)
        XCTAssertTrue(try decodeParty(options: #"{"guests":"invite"}"#).voiceEnabled)
        XCTAssertTrue(try decodeParty(options: #"{"guests":"request"}"#).voiceEnabled)
    }

    // MARK: - Which failure copy for this room

    func testAWatchPartyChannelIsAStreamRoom() {
        XCTAssertEqual(sfuRoomKind(isWatchPartyChannel: true), .stream)
        XCTAssertEqual(sfuRoomKind(isWatchPartyChannel: false), .call)
    }

    private let everyShownError: [SfuJoinError] = [
        .token("500"), .connect("refused"), .timedOut, .microphone("timedOut"), .lost("gone"),
    ]

    /// "the voice server error is cause it shouldn't be a voice server
    /// anyway". No failure in a watch party's room mentions a voice server
    /// or a call, promoted or not.
    func testNoStreamFailureMentionsAVoiceServerOrACall() {
        for error in everyShownError {
            for promoted in [false, true] {
                let message = sfuFailureMessage(error, promoted: promoted, room: .stream)
                XCTAssertNotNil(message, "\(error)")
                XCTAssertFalse(message?.contains("voice server") ?? true, "\(error): \(message ?? "")")
                XCTAssertFalse(message?.contains("call") ?? true, "\(error): \(message ?? "")")
            }
        }
        XCTAssertNil(sfuFailureMessage(.superseded, room: .stream))
    }

    /// The connect failure says the stream server, in the words asked for.
    func testAStreamConnectFailureNamesTheStreamServer() {
        for error in [SfuJoinError.token("500"), .connect("refused"), .timedOut] {
            XCTAssertEqual(
                sfuFailureMessage(error, room: .stream),
                "Could not connect to the stream server. Check your network and try again."
            )
        }
    }

    /// Every other room keeps the words it had.
    func testAVoiceChannelKeepsItsCallCopy() {
        for error in everyShownError {
            XCTAssertEqual(sfuFailureMessage(error, room: .call), sfuFailureMessage(error))
        }
        XCTAssertEqual(sfuMicrophoneFailureNotice(room: .call), sfuMicrophoneFailureNotice())
    }

    /// A microphone never ends a broadcast: a clean failure keeps the seat
    /// muted even where a call would not (`keepsSeat: false`), and a microphone
    /// in an unknown state is silenced rather than ending the stream.
    func testAMicrophoneNeverEndsABroadcast() {
        let notice = sfuMicrophoneFailureNotice(room: .stream)
        XCTAssertFalse(notice.contains("voice server"))
        XCTAssertTrue(notice.contains("stream"))
        for keepsSeat in [false, true] {
            for wasMuted in [false, true] {
                XCTAssertEqual(
                    sfuMicrophoneDisposition(
                        .failed("timedOut"), wasMuted: wasMuted, keepsSeat: keepsSeat, room: .stream
                    ),
                    .keep(muted: true, notice: notice)
                )
                XCTAssertEqual(
                    sfuMicrophoneDisposition(
                        .unknownState("unpublish"), wasMuted: wasMuted, keepsSeat: keepsSeat, room: .stream
                    ),
                    .silence(notice: notice)
                )
            }
        }
    }

    /// Farol on #843: a silence that is not confirmed must not leave a control
    /// reading muted over a microphone that may be sending. Confirmed, the
    /// seat stays muted; not confirmed, the session ends as a microphone
    /// failure, in the stream's words.
    func testASilenceIsKeptOnlyWhenConfirmed() {
        let notice = sfuMicrophoneFailureNotice(room: .stream)
        XCTAssertEqual(
            sfuMicrophoneAfterSilence(notice: notice, confirmed: true),
            .keep(muted: true, notice: notice)
        )
        guard case .end(let error) = sfuMicrophoneAfterSilence(notice: notice, confirmed: false) else {
            return XCTFail("an unconfirmed silence must end the session")
        }
        guard case .microphone = error else { return XCTFail("expected a microphone failure, got \(error)") }
        let message = sfuFailureMessage(error, room: .stream)
        XCTAssertFalse(message?.contains("voice server") ?? true)
    }

    /// A room that has gone is still the end of the session, in stream words.
    func testALostStreamRoomStillEnds() {
        XCTAssertEqual(
            sfuMicrophoneDisposition(.roomLost("gone"), wasMuted: false, keepsSeat: true, room: .stream),
            .end(.lost("gone"))
        )
    }

    // MARK: - The stage before any seat

    private func party(state: String, viewerRole: String = "host") -> WatchPartyPayload {
        WatchPartyPayload(
            id: "p1", channelId: "c1", name: "Sessão", state: state,
            hostUserId: "u1", hostDisplayName: "Rafael", viewerRole: viewerRole
        )
    }

    private func card(
        party: WatchPartyKnowledge,
        canStart: Bool = true,
        enabled: Bool = true,
        isWatchParty: Bool = true,
        isSeated: Bool = false
    ) -> WatchPartyStageHostCard {
        watchPartyStageHostCard(
            isWatchPartyChannel: isWatchParty,
            serverWatchPartyEnabled: enabled,
            canStartWatchParty: canStart,
            party: party,
            isSeated: isSeated
        )
    }

    /// The setup card is on the stage for a host who has taken no seat.
    func testAHostsDraftShowsTheSetupCardWithNoSeat() {
        let draft = party(state: "draft")
        XCTAssertEqual(card(party: .known(draft)), .setup(draft))
        let scheduled = party(state: "scheduled")
        XCTAssertEqual(card(party: .known(scheduled)), .setup(scheduled))
    }

    func testNoPartyOffersCreateToSomebodyWhoMayStartOne() {
        XCTAssertEqual(card(party: .known(nil)), .create)
        XCTAssertEqual(card(party: .known(party(state: "ended"))), .create)
        XCTAssertEqual(card(party: .known(nil), canStart: false), .hidden)
    }

    /// A live party the host runs, with no seat behind it, offers the way back
    /// in and End.
    func testAHostsLivePartyWithNoSeatOffersRejoin() {
        let live = party(state: "live")
        XCTAssertEqual(card(party: .known(live)), .live(live))
    }

    /// Seated, the call screen owns the controls.
    func testASeatedHostSeesNoStageCard() {
        XCTAssertEqual(card(party: .known(party(state: "draft")), isSeated: true), .hidden)
        XCTAssertEqual(card(party: .known(nil), isSeated: true), .hidden)
    }

    /// Ordinary viewers are unchanged: nothing to host, so nothing drawn.
    func testAViewerSeesNoHostCard() {
        XCTAssertEqual(card(party: .known(party(state: "live", viewerRole: "viewer"))), .hidden)
        XCTAssertEqual(card(party: .known(party(state: "live", viewerRole: "viewer")), canStart: false), .hidden)
    }

    func testNothingUntilThePartyIsKnownOrWhenWatchPartiesAreOff() {
        XCTAssertEqual(card(party: .unknown), .hidden)
        XCTAssertEqual(card(party: .known(nil), enabled: false), .hidden)
        XCTAssertEqual(card(party: .known(nil), isWatchParty: false), .hidden)
    }

    /// The setup and live cards are the host's way in, so the toolbar's
    /// call button steps aside for them; Create is not a seat.
    func testOnlyTheSetupAndLiveCardsReplaceTheToolbarJoin() {
        XCTAssertTrue(WatchPartyStageHostCard.setup(party(state: "draft")).isTheWayIn)
        XCTAssertTrue(WatchPartyStageHostCard.live(party(state: "live")).isTheWayIn)
        XCTAssertFalse(WatchPartyStageHostCard.create.isTheWayIn)
        XCTAssertFalse(WatchPartyStageHostCard.hidden.isTheWayIn)
    }

    // MARK: - The wiring, read from the source

    private var sources: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .appending(path: "Sources")
    }

    private func source(_ path: String) throws -> String {
        try String(contentsOf: sources.appending(path: path), encoding: .utf8)
    }

    /// TestFlight 1.0.5's "Tap to continue" joined the room to reach the setup
    /// card. The tap opens the channel now and never joins.
    func testTheHostsCardTapNoLongerJoinsTheRoom() throws {
        let list = try source("Chat/ChannelListView.swift")
        guard let start = list.range(of: "private func landOnHostStage(") else {
            return XCTFail("landOnHostStage is gone")
        }
        let body = list[start.upperBound...].prefix(600)
        XCTAssertFalse(body.contains("voice.join("), "the host's card tap must not take a seat")
        XCTAssertTrue(body.contains("openedChannel = channel"))
    }

    /// Go live and Rejoin on the stage ask the same microphone question.
    func testTheStageAsksTheHostMicrophoneRuleOnEveryJoin() throws {
        let stage = try source("Voice/WatchPartyStageHostView.swift")
        let asks = stage.components(
            separatedBy: "microphone: watchPartyHostSeatMicrophone(voiceEnabled: party.voiceEnabled)"
        ).count - 1
        XCTAssertEqual(asks, 2, "Go live and Rejoin must both pass the host microphone rule")
        let controller = try source("Voice/WatchPartyHostController.swift")
        XCTAssertTrue(controller.contains("serverName: serverName, microphone: microphone"))
    }

    /// Farol on #843: Rejoin and Go live leave a failed session for the same
    /// room before joining, or the join reads as a reopen and never tries.
    func testRejoinAndGoLiveLeaveAFailedSessionFirst() throws {
        let leaveFailed = "if case .failed = voice.status, voice.channelId == channel.id {\n"
        let stage = try source("Voice/WatchPartyStageHostView.swift")
        XCTAssertTrue(stage.contains(leaveFailed))
        let controller = try source("Voice/WatchPartyHostController.swift")
        XCTAssertTrue(controller.contains(leaveFailed))
    }

    /// The toolbar's Join steps aside for the host's own card.
    func testTheToolbarJoinStepsAsideForTheHostsCard() throws {
        let chat = try source("Chat/ChatView.swift")
        XCTAssertTrue(chat.contains("if watchPartyStageCard.isTheWayIn { return false }"))
        XCTAssertTrue(chat.contains("if let voiceChannel, offersJoin(voiceChannel) {"))
    }
}
