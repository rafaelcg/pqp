import XCTest
@testable import pqp

/// The WS frames this client parses BY TYPE, pinned against the shapes in
/// `packages/shared/src` — the Zod schemas are the wire contract, and a decode
/// rule that drifts fails as a silently dropped frame, not an error.
final class WireDecodingTests: XCTestCase {
    private func firstEvent(from json: String) async -> RealtimeEvent? {
        let client = RealtimeClient(backend: .local, tokenProvider: DevTokenProvider())
        let stream = await client.events()
        await client.ingest(Data(json.utf8))
        var iterator = stream.makeAsyncIterator()
        let waiter = Task { await iterator.next() }
        let timeout = Task {
            try? await Task.sleep(for: .seconds(2))
            waiter.cancel()
        }
        let event = await waiter.value
        timeout.cancel()
        return event
    }

    /// `sanction-notice` reuses the key `message` for a string where chat
    /// frames carry an object — the frame must not fall into the shared
    /// envelope, where that clash makes the whole decode fail.
    func testSanctionNoticeDecodesWithItsStringMessage() async throws {
        let json = """
        {"type":"sanction-notice","sanction":"timeout",
         "serverId":"11111111-1111-1111-1111-111111111111",
         "channelId":"22222222-2222-2222-2222-222222222222",
         "expiresAt":"2026-08-07T12:00:00.000Z","reason":null,
         "message":"You are timed out in this server until 2026-08-07T12:00:00.000Z. You can still read, but you cannot post, react or join voice until then."}
        """
        let event = await firstEvent(from: json)
        guard case .sanctionNotice(let notice) = event else {
            return XCTFail("Expected sanctionNotice, got \(String(describing: event))")
        }
        XCTAssertEqual(notice.sanction, "timeout")
        XCTAssertEqual(notice.channelId, "22222222-2222-2222-2222-222222222222")
        XCTAssertTrue(notice.message.contains("timed out"))
        XCTAssertNil(notice.reason)
    }

    // MARK: - message-rejected

    /// The server's answer to a refused send. Before this case existed the
    /// frame decoded to `.other`, so the optimistic row stayed dimmed forever
    /// and a refused message looked sent. `retryAfterMs` is the slow mode
    /// wait, and it has to survive the decode or the countdown has nothing to
    /// count.
    func testMessageRejectedDecodesWithRetryAfter() async throws {
        let json = """
        {"type":"message-rejected","channelId":"22222222-2222-2222-2222-222222222222",
         "nonce":"abc123","reason":"slow-mode","retryAfterMs":12000}
        """
        let event = await firstEvent(from: json)
        guard case .messageRejected(let rejection) = event else {
            return XCTFail("Expected messageRejected, got \(String(describing: event))")
        }
        XCTAssertEqual(rejection.channelId, "22222222-2222-2222-2222-222222222222")
        XCTAssertEqual(rejection.nonce, "abc123")
        XCTAssertEqual(rejection.reason, "slow-mode")
        XCTAssertEqual(rejection.retryAfterMs, 12000)
    }

    /// The permanent refusals carry neither a wait nor, on the schema, a
    /// required nonce. Both optionals must read as absent, not fail the decode.
    func testMessageRejectedWithoutOptionalsDecodes() async throws {
        let json = """
        {"type":"message-rejected","channelId":"22222222-2222-2222-2222-222222222222",
         "reason":"undeliverable"}
        """
        let event = await firstEvent(from: json)
        guard case .messageRejected(let rejection) = event else {
            return XCTFail("Expected messageRejected, got \(String(describing: event))")
        }
        XCTAssertNil(rejection.nonce)
        XCTAssertNil(rejection.retryAfterMs)
        XCTAssertEqual(rejection.reason, "undeliverable")
    }

    // MARK: - peer-updated

    /// A rename mid-call. Its own event rather than a second `peer-joined`,
    /// because a join opens a peer connection and a rename must not.
    func testPeerUpdatedDecodesAsItsOwnEvent() async throws {
        let json = """
        {"type":"peer-updated","peer":{"peerId":"p1","userId":"u1",
         "displayName":"Ana Renamed","avatarUrl":null,"sharingScreen":false}}
        """
        let event = await firstEvent(from: json)
        guard case .voicePeerUpdated(let peer) = event else {
            return XCTFail("Expected voicePeerUpdated, got \(String(describing: event))")
        }
        XCTAssertEqual(peer.peerId, "p1")
        XCTAssertEqual(peer.displayName, "Ana Renamed")
        XCTAssertNil(peer.avatarUrl)
    }

    // MARK: - serverMuted

    /// A moderator's mute rides on the participant shape, so it arrives on
    /// every frame that carries one. On mesh this flag IS the mute: the server
    /// cannot touch media, and the only thing that silences the person is each
    /// receiver reading `true` here and playing them at zero. A decode that
    /// drops the key is a room that agreed not to hear somebody and still does.
    func testPeerUpdatedCarriesServerMuted() async throws {
        let json = """
        {"type":"peer-updated","peer":{"peerId":"p1","userId":"u1",
         "displayName":"Ana","avatarUrl":null,"muted":false,"serverMuted":true}}
        """
        let event = await firstEvent(from: json)
        guard case .voicePeerUpdated(let peer) = event else {
            return XCTFail("Expected voicePeerUpdated, got \(String(describing: event))")
        }
        XCTAssertTrue(peer.serverMuted)
        XCTAssertFalse(peer.muted, "the moderator's flag must not be confused with self-mute")
    }

    /// An older server omits the key, the same way it did `muted` and
    /// `deafened` before it learned them. Absent reads as "nobody is muted",
    /// never as a failed frame: failing here would drop the whole roster.
    func testServerMutedDefaultsToFalseWhenAbsent() throws {
        let json = #"{"peerId":"p1","userId":"u1","displayName":"Ana","avatarUrl":null}"#
        let peer = try Coding.decoder.decode(VoiceParticipant.self, from: Data(json.utf8))
        XCTAssertFalse(peer.serverMuted)
    }

    /// The share's audio stream id rides on the same shape
    /// (`voiceParticipantSchema.screenAudioStreamId`), and is what lets a
    /// server mute take the microphone and leave the film. Nullable and
    /// optional on the wire; both read as "no share sound".
    func testScreenAudioStreamIdDecodesAndTreatsNullAsAbsent() throws {
        let with = #"{"peerId":"p1","userId":"u1","displayName":"Ana","screenAudioStreamId":"cap-1"}"#
        let null = #"{"peerId":"p1","userId":"u1","displayName":"Ana","screenAudioStreamId":null}"#
        let absent = #"{"peerId":"p1","userId":"u1","displayName":"Ana"}"#
        XCTAssertEqual(
            try Coding.decoder.decode(VoiceParticipant.self, from: Data(with.utf8)).screenAudioStreamId,
            "cap-1"
        )
        XCTAssertNil(try Coding.decoder.decode(VoiceParticipant.self, from: Data(null.utf8)).screenAudioStreamId)
        XCTAssertNil(try Coding.decoder.decode(VoiceParticipant.self, from: Data(absent.utf8)).screenAudioStreamId)
    }

    /// `welcome` carries it on both the existing peers and on `self`, which is
    /// how a mute placed before we walked in, or one that outlived our last
    /// socket, reaches us at all.
    func testWelcomeCarriesServerMutedOnPeersAndSelf() async throws {
        let json = """
        {"type":"welcome","peerId":"me","voiceChannelId":"33333333-3333-3333-3333-333333333333",
         "peers":[{"peerId":"p1","userId":"u1","displayName":"Ana","avatarUrl":null,"serverMuted":true}],
         "self":{"peerId":"me","userId":"u0","displayName":"Eu","avatarUrl":null,"serverMuted":true},
         "transport":"mesh"}
        """
        let event = await firstEvent(from: json)
        guard case .voiceWelcome(_, _, let peers, let selfPeer, _) = event else {
            return XCTFail("Expected voiceWelcome, got \(String(describing: event))")
        }
        XCTAssertEqual(peers.map(\.serverMuted), [true])
        XCTAssertTrue(selfPeer.serverMuted)
    }

    // MARK: - friend-activity

    /// The nudge that makes a friend request visible without a pull-to-refresh.
    ///
    /// Content-free by design: the frame names nobody, and the recipient learns
    /// who from `GET /api/friends`. So the only thing to decode is `kind`, and
    /// the only thing to get wrong is dropping the frame entirely — which is
    /// exactly what happened for the whole life of the feature before it existed.
    func testFriendActivityRequestDecodes() async throws {
        let event = await firstEvent(from: #"{"type":"friend-activity","kind":"request"}"#)
        guard case .friendActivity(let kind) = event else {
            return XCTFail("Expected friendActivity, got \(String(describing: event))")
        }
        XCTAssertEqual(kind, .request)
    }

    func testFriendActivityAcceptedDecodes() async throws {
        let event = await firstEvent(from: #"{"type":"friend-activity","kind":"accepted"}"#)
        guard case .friendActivity(let kind) = event else {
            return XCTFail("Expected friendActivity, got \(String(describing: event))")
        }
        XCTAssertEqual(kind, .accepted)
    }

    /// A `kind` outside the enum is dropped rather than defaulted. A nudge whose
    /// reason we cannot name is a refresh with no story behind it — and the two
    /// spellings the server will never send are `declined` and `cancelled`,
    /// which are silent on purpose and must stay that way even if some future
    /// build gets them wrong.
    func testFriendActivityWithAnUnknownKindIsDropped() async throws {
        let event = await firstEvent(from: #"{"type":"friend-activity","kind":"declined"}"#)
        if case .friendActivity = event {
            XCTFail("An unknown kind must not produce a nudge")
        }
    }

    /// The transport pin travels on `welcome`; losing it is how a client
    /// half-joins a LiveKit room over mesh and hears nobody.
    func testWelcomeCarriesTheTransportPin() async throws {
        let json = """
        {"type":"welcome","peerId":"p1","voiceChannelId":"33333333-3333-3333-3333-333333333333",
         "peers":[],"self":{"peerId":"p1","userId":"44444444-4444-4444-4444-444444444444",
         "displayName":"Ana","avatarUrl":null,"sharingScreen":false},
         "transport":"livekit"}
        """
        let event = await firstEvent(from: json)
        guard case .voiceWelcome(_, _, _, _, let transport) = event else {
            return XCTFail("Expected voiceWelcome, got \(String(describing: event))")
        }
        XCTAssertEqual(transport, "livekit")
    }

    /// Absent on a pre-SFU server — must decode as nil, not fail.
    func testWelcomeWithoutTransportStillDecodes() async throws {
        let json = """
        {"type":"welcome","peerId":"p1","voiceChannelId":"33333333-3333-3333-3333-333333333333",
         "peers":[],"self":{"peerId":"p1","userId":"44444444-4444-4444-4444-444444444444",
         "displayName":"Ana","avatarUrl":null}}
        """
        let event = await firstEvent(from: json)
        guard case .voiceWelcome(_, _, _, _, let transport) = event else {
            return XCTFail("Expected voiceWelcome, got \(String(describing: event))")
        }
        XCTAssertNil(transport)
    }

    func testVoiceTransportUnsupportedDecodes() async throws {
        let json = """
        {"type":"voice-transport-unsupported",
         "voiceChannelId":"33333333-3333-3333-3333-333333333333","transport":"livekit"}
        """
        let event = await firstEvent(from: json)
        guard case .voiceTransportUnsupported(let channelId, let transport) = event else {
            return XCTFail("Expected voiceTransportUnsupported, got \(String(describing: event))")
        }
        XCTAssertEqual(channelId, "33333333-3333-3333-3333-333333333333")
        XCTAssertEqual(transport, "livekit")
    }

    /// The server is growing threads; a message carrying the new `thread` key
    /// (and any other future key) must keep decoding on this client.
    func testMessageBroadcastToleratesUnknownFields() async throws {
        let json = """
        {"type":"message-broadcast","nonce":"n1","message":{
         "id":"55555555-5555-5555-5555-555555555555",
         "channelId":"22222222-2222-2222-2222-222222222222",
         "authorId":"44444444-4444-4444-4444-444444444444",
         "authorName":"Ana","authorTag":"ana#0001","authorAvatarUrl":null,
         "body":"oi","createdAt":"2026-08-07T11:00:00.000Z",
         "thread":{"id":"66666666-6666-6666-6666-666666666666","messageCount":3},
         "someFutureKey":true}}
        """
        let event = await firstEvent(from: json)
        guard case .messageCreated(let message, let nonce) = event else {
            return XCTFail("Expected messageCreated, got \(String(describing: event))")
        }
        XCTAssertEqual(message.body, "oi")
        XCTAssertEqual(nonce, "n1")
    }

    /// Both deletion spellings are live on the wire.
    func testBothDeleteSpellingsDecode() async throws {
        for type in ["message-delete", "message-deleted"] {
            let json = """
            {"type":"\(type)","channelId":"22222222-2222-2222-2222-222222222222",
             "messageId":"55555555-5555-5555-5555-555555555555"}
            """
            let event = await firstEvent(from: json)
            guard case .messageDeleted = event else {
                return XCTFail("\(type) did not decode as messageDeleted")
            }
        }
    }

    /// `channel-activity` for a DM carries `serverId: null` — the routing key
    /// between the server badge list and the conversation list.
    func testDmActivityHasNilServerId() async throws {
        let json = """
        {"type":"channel-activity","serverId":null,"kind":"dm",
         "channelId":"22222222-2222-2222-2222-222222222222","mention":true}
        """
        let event = await firstEvent(from: json)
        guard case .activity(_, let serverId, let mention) = event else {
            return XCTFail("Expected activity, got \(String(describing: event))")
        }
        XCTAssertNil(serverId)
        XCTAssertTrue(mention)
    }

    /// A non-null `serverId` has to survive too. The negative case above was
    /// the only one pinned, and it passes just as well against a decoder that
    /// drops the field entirely.
    func testServerActivityKeepsItsServerId() async throws {
        let json = """
        {"type":"channel-activity","serverId":"33333333-3333-3333-3333-333333333333",
         "kind":"server","channelId":"22222222-2222-2222-2222-222222222222","mention":false}
        """
        let event = await firstEvent(from: json)
        guard case .activity(_, let serverId, _) = event else {
            return XCTFail("Expected activity, got \(String(describing: event))")
        }
        XCTAssertEqual(serverId, "33333333-3333-3333-3333-333333333333")
    }

    /// `permissions-update` is what tells a phone that a channel it is showing
    /// is no longer one this account may see.
    ///
    /// Decoding it wrong is silent in both directions: as `.other` the sidebar
    /// keeps a channel the server will not serve, and with the wrong `serverId`
    /// the wrong server gets refetched while the right one goes stale.
    func testPermissionsUpdateDecodes() async throws {
        let json = """
        {"type":"permissions-update","serverId":"33333333-3333-3333-3333-333333333333","version":7}
        """
        let event = await firstEvent(from: json)
        guard case .permissionsUpdate(let serverId, let version) = event else {
            return XCTFail("Expected permissionsUpdate, got \(String(describing: event))")
        }
        XCTAssertEqual(serverId, "33333333-3333-3333-3333-333333333333")
        XCTAssertEqual(version, 7)
    }

    /// The version is advisory. A frame without one still has to arrive, because
    /// the client refetches either way.
    func testPermissionsUpdateWithoutAVersionStillArrives() async throws {
        let json = """
        {"type":"permissions-update","serverId":"33333333-3333-3333-3333-333333333333"}
        """
        let event = await firstEvent(from: json)
        guard case .permissionsUpdate(_, let version) = event else {
            return XCTFail("Expected permissionsUpdate, got \(String(describing: event))")
        }
        XCTAssertNil(version)
    }

    /// `/api/me` decides the age-gate route; absent must read as "predates the
    /// gate", never as pending.
    func testCurrentUserAgeGateDecoding() throws {
        let with = """
        {"id":"44444444-4444-4444-4444-444444444444","clerkId":"c1",
         "displayName":"Ana","username":"ana","discriminator":"0001",
         "tag":"ana#0001","avatarUrl":null,"dmPrivacy":"server_members",
         "ageGate":"pending"}
        """
        let user = try Coding.decoder.decode(CurrentUser.self, from: Data(with.utf8))
        XCTAssertEqual(user.ageGate, "pending")

        let without = """
        {"id":"44444444-4444-4444-4444-444444444444","clerkId":"c1",
         "displayName":"Ana","username":"ana","discriminator":"0001",
         "tag":"ana#0001","avatarUrl":null,"dmPrivacy":"server_members"}
        """
        let older = try Coding.decoder.decode(CurrentUser.self, from: Data(without.utf8))
        XCTAssertNil(older.ageGate)
    }
}
