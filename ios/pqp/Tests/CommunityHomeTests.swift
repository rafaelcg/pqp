import XCTest
@testable import pqp

/// What the Baú looks like on the wire, decoded the way the app decodes it.
///
/// The locked case is the one worth pinning: the API strips body, media and
/// the comment words for a member without the cargo, and the card has to
/// render the lock from what is *absent* rather than from any flag it could be
/// tempted to trust on its own.
final class CommunityHomeDecodingTests: XCTestCase {
    private let author = """
    {"id":"33333333-3333-3333-3333-333333333333","displayName":"Rafa",
     "username":"rafa","tag":"rafa#0001","avatarUrl":null}
    """

    private func post(_ extra: String) -> Data {
        Data("""
        {
          "id": "11111111-1111-1111-1111-111111111111",
          "serverId": "22222222-2222-2222-2222-222222222222",
          "author": \(author),
          "authorBadge": "owner",
          "title": "Clipe da sessão",
          "visibility": "members",
          "status": "published",
          "commentsEnabled": true,
          "likeCount": 3,
          "likedByMe": false,
          "commentCount": 5,
          "scheduledAt": null,
          "scheduleTimezone": null,
          "publishedAt": "2026-08-30T20:00:00.000Z",
          "createdAt": "2026-08-30T19:00:00.000Z",
          "updatedAt": "2026-08-30T19:00:00.000Z",
          \(extra)
        }
        """.utf8)
    }

    func testALockedPostArrivesWithNoBodyNoMediaAndNoCommentWords() throws {
        let locked = try Coding.decoder.decode(
            CommunityHomePost.self,
            from: post(#""body": null, "teaser": "Só pra VIP", "media": null, "locked": true, "commentTeaser": []"#)
        )
        XCTAssertTrue(locked.locked)
        XCTAssertNil(locked.body)
        XCTAssertNil(locked.media)
        XCTAssertEqual(locked.teaser, "Só pra VIP")
        XCTAssertTrue(locked.isMembersOnly)
        // The count survives the lock; the words do not.
        XCTAssertEqual(locked.commentCount, 5)
        XCTAssertTrue(locked.commentTeaser.isEmpty)
        XCTAssertEqual(locked.shownAt, ISO8601DateFormatter().date(from: "2026-08-30T20:00:00Z"))
    }

    func testAnUnlockedPostCarriesItsMediaAndTheTwoNewestComments() throws {
        let open = try Coding.decoder.decode(CommunityHomePost.self, from: post("""
            "body": "Olha isso",
            "teaser": null,
            "locked": false,
            "media": {"kind":"file","name":"regras.pdf","contentType":"application/pdf",
                      "byteSize":120000,"url":"https://storage.example/regras.pdf","youtubeUrl":null},
            "commentTeaser": [
              {"id":"44444444-4444-4444-4444-444444444444","author":\(author),"body":"top","createdAt":"2026-08-30T21:00:00.000Z"},
              {"id":"55555555-5555-5555-5555-555555555555","author":\(author),"body":"demais","createdAt":"2026-08-30T22:00:00.000Z"}
            ]
            """))
        XCTAssertFalse(open.locked)
        XCTAssertEqual(open.body, "Olha isso")
        XCTAssertEqual(open.commentTeaser.count, 2)
        let media = try XCTUnwrap(open.media)
        XCTAssertTrue(media.isFile)
        XCTAssertEqual(media.openURL?.absoluteString, "https://storage.example/regras.pdf")
        XCTAssertEqual(media.byteSize, 120000)
    }

    func testYouTubeMediaOpensTheWatchPageRatherThanAStorageURL() throws {
        let media = try Coding.decoder.decode(CommunityHomeMedia.self, from: Data("""
            {"kind":"youtube","name":"","contentType":null,"byteSize":null,"url":null,
             "youtubeUrl":"https://www.youtube.com/watch?v=dQw4w9WgXcQ"}
            """.utf8))
        XCTAssertTrue(media.isYoutube)
        XCTAssertEqual(media.openURL?.absoluteString, "https://www.youtube.com/watch?v=dQw4w9WgXcQ")
        XCTAssertEqual(
            YoutubeLinks.thumbnailURL(media.youtubeUrl)?.absoluteString,
            "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"
        )
    }

    func testAPostTheServerHasGrownFieldsOnStillDecodes() throws {
        let grown = try Coding.decoder.decode(
            CommunityHomePost.self,
            from: post(#""body": "x", "locked": false, "media": null, "commentTeaser": [], "pollId": "abc""#)
        )
        XCTAssertEqual(grown.body, "x")
    }

    func testTheConfigReadsAsOffWhenAFieldIsMissing() throws {
        let partial = try Coding.decoder.decode(CommunityHomeConfig.self, from: Data(#"{"enabled": true}"#.utf8))
        XCTAssertTrue(partial.enabled)
        XCTAssertFalse(partial.vipEnabled)
        XCTAssertFalse(partial.mediaEnabled)
        XCTAssertFalse(try Coding.decoder.decode(CommunityHomeConfig.self, from: Data("{}".utf8)).enabled)
    }

    /// A server that predates the Baú does not send the switch, and must still
    /// appear in the rail.
    func testAServerWithoutTheSwitchDecodesAsOff() throws {
        let server = try Coding.decoder.decode(Server.self, from: Data("""
            {"id":"22222222-2222-2222-2222-222222222222","name":"QG","ownerId":"x",
             "createdAt":"2026-08-30T19:00:00.000Z"}
            """.utf8))
        XCTAssertFalse(server.communityHomeEnabled)
        let opted = try Coding.decoder.decode(Server.self, from: Data("""
            {"id":"22222222-2222-2222-2222-222222222222","name":"QG","ownerId":"x",
             "createdAt":"2026-08-30T19:00:00.000Z","communityHomeEnabled":true}
            """.utf8))
        XCTAssertTrue(opted.communityHomeEnabled)
    }
}

/// A port of `parseYoutubeVideoId` in `packages/shared/src/community-home.ts`.
final class YoutubeLinksTests: XCTestCase {
    func testEveryShapeTheSharedParserAccepts() {
        let id = "dQw4w9WgXcQ"
        for url in [
            "https://www.youtube.com/watch?v=\(id)",
            "https://youtube.com/watch?v=\(id)&t=42",
            "https://m.youtube.com/watch?v=\(id)",
            "https://music.youtube.com/watch?v=\(id)",
            "https://youtu.be/\(id)",
            "https://youtu.be/\(id)?si=abc",
            "https://www.youtube.com/shorts/\(id)",
            "https://www.youtube.com/embed/\(id)",
            "https://www.youtube.com/live/\(id)",
            "  https://youtu.be/\(id)  ",
        ] {
            XCTAssertEqual(YoutubeLinks.videoId(url), id, url)
        }
    }

    func testEverythingElseIsNotAVideo() {
        for url in [
            "",
            "   ",
            "not a url",
            "https://example.com/watch?v=dQw4w9WgXcQ",
            "https://www.youtube.com/watch?v=short",
            "https://www.youtube.com/channel/dQw4w9WgXcQ",
            "https://youtu.be/",
            "https://www.youtube.com/watch",
        ] {
            XCTAssertNil(YoutubeLinks.videoId(url), url)
        }
        XCTAssertNil(YoutubeLinks.videoId(nil))
        XCTAssertNil(YoutubeLinks.thumbnailURL("https://example.com"))
    }
}
