import XCTest
@testable import pqp

/// Baú video subtitles: the wire shape, the WebVTT reader, and the rules that
/// decide which track, whether it starts on, and whether it fits the file.
/// The rule cases mirror `client/src/lib/community-home/captions.ts`.
final class BauCaptionsTests: XCTestCase {
    // MARK: - Wire

    private func post(_ extra: String) -> Data {
        Data("""
        {
          "id": "11111111-1111-1111-1111-111111111111",
          "serverId": "22222222-2222-2222-2222-222222222222",
          "author": {"id":"33333333-3333-3333-3333-333333333333","displayName":"Rafa",
                     "username":"rafa","tag":"rafa#0001","avatarUrl":null},
          "visibility": "free", "commentsEnabled": true, "locked": false,
          "likeCount": 0, "likedByMe": false, "commentCount": 0,
          "publishedAt": "2026-08-30T20:00:00.000Z",
          "createdAt": "2026-08-30T19:00:00.000Z"\(extra)
        }
        """.utf8)
    }

    func testPostCaptionsDecode() throws {
        let decoded = try Coding.decoder.decode(
            CommunityHomePost.self,
            from: post(#", "captions": {"sourceLang":"pt","langs":["pt","en"],"durationMs":93400}"#)
        )
        XCTAssertEqual(decoded.captions, BauPostCaptions(sourceLang: "pt", langs: ["pt", "en"], durationMs: 93_400))
    }

    func testAbsentNullAndMalformedCaptionsAreNilAndKeepThePost() throws {
        for extra in ["", #", "captions": null"#, #", "captions": {"langs": 7}"#, #", "captions": "yes""#] {
            let decoded = try Coding.decoder.decode(CommunityHomePost.self, from: post(extra))
            XCTAssertNil(decoded.captions, extra)
            XCTAssertEqual(decoded.id, "11111111-1111-1111-1111-111111111111")
        }
    }

    func testCaptionsWithoutDurationOrLangsStillDecode() throws {
        let decoded = try Coding.decoder.decode(
            CommunityHomePost.self, from: post(#", "captions": {"sourceLang":"und"}"#)
        )
        XCTAssertEqual(decoded.captions?.langs, [])
        XCTAssertNil(decoded.captions?.durationMs)
    }

    func testTracksResponseDecodes() throws {
        let json = #"{"tracks":[{"lang":"pt","source":true,"auto":true,"vtt":"WEBVTT\n\n"}]}"#
        let decoded = try JSONDecoder().decode(BauCaptionsResponse.self, from: Data(json.utf8))
        XCTAssertEqual(decoded.tracks.first?.lang, "pt")
        XCTAssertEqual(decoded.tracks.first?.source, true)
    }

    // MARK: - WebVTT

    func testReadsCuesWithHoursOrWithout() {
        let vtt = """
        WEBVTT

        00:00:01.000 --> 00:00:03.500
        Oi, pessoal

        1
        01:02.250 --> 01:04.000 align:center
        Segunda linha
        e uma terceira

        """
        XCTAssertEqual(WebVTT.cues(from: vtt), [
            BauCaptionCue(start: 1, end: 3.5, text: "Oi, pessoal"),
            BauCaptionCue(start: 62.25, end: 64, text: "Segunda linha\ne uma terceira"),
        ])
    }

    func testStripsTagsDecodesEntitiesAndAcceptsCRLFAndCommaMilliseconds() {
        let vtt = "WEBVTT\r\n\r\n00:00:00,500 --> 00:00:02,000\r\n<i>Tom &amp; Jerry</i> &lt;3\r\n\r\n"
        XCTAssertEqual(WebVTT.cues(from: vtt), [BauCaptionCue(start: 0.5, end: 2, text: "Tom & Jerry <3")])
    }

    func testSkipsBrokenBlocksButKeepsTheRest() {
        let vtt = """
        WEBVTT

        NOTE isto nao e legenda

        00:00:xx.000 --> 00:00:03.000
        quebrada

        00:00:05.000 --> 00:00:04.000
        fim antes do comeco

        00:00:06.000 --> 00:00:07.000

        00:00:08.000 --> 00:00:09.000
        boa
        """
        XCTAssertEqual(WebVTT.cues(from: vtt), [BauCaptionCue(start: 8, end: 9, text: "boa")])
        XCTAssertEqual(WebVTT.cues(from: ""), [])
    }

    func testTextAtTimeUsesAHalfOpenWindow() {
        let cues = [BauCaptionCue(start: 1, end: 2, text: "a"), BauCaptionCue(start: 2, end: 3, text: "b")]
        XCTAssertNil(BauCaptionRules.text(at: 0.9, in: cues))
        XCTAssertEqual(BauCaptionRules.text(at: 1, in: cues), "a")
        XCTAssertEqual(BauCaptionRules.text(at: 2, in: cues), "b")
        XCTAssertNil(BauCaptionRules.text(at: 3, in: cues))
    }

    // MARK: - Rules

    private func track(_ lang: String, source: Bool) -> BauCaptionTrack {
        BauCaptionTrack(lang: lang, source: source, vtt: "WEBVTT")
    }

    func testPicksTheReadersLanguageThenTheSourceThenTheFirst() {
        let both = [track("pt", source: true), track("en", source: false)]
        XCTAssertEqual(BauCaptionRules.pick(both, readerLocale: "en")?.lang, "en")
        XCTAssertEqual(BauCaptionRules.pick(both, readerLocale: "pt-BR")?.lang, "pt")
        XCTAssertEqual(BauCaptionRules.pick(both, readerLocale: "es")?.lang, "pt")
        let noSource = [track("fr", source: false), track("de", source: false)]
        XCTAssertEqual(BauCaptionRules.pick(noSource, readerLocale: "en")?.lang, "fr")
        XCTAssertNil(BauCaptionRules.pick([], readerLocale: "en"))
    }

    func testStartsOnOnlyWhenTheVideoIsInAnotherLanguage() {
        XCTAssertTrue(BauCaptionRules.onByDefault(sourceLang: "pt", readerLocale: "en", stored: nil))
        XCTAssertFalse(BauCaptionRules.onByDefault(sourceLang: "pt", readerLocale: "pt-BR", stored: nil))
        XCTAssertFalse(BauCaptionRules.onByDefault(sourceLang: "pt-PT", readerLocale: "pt-BR", stored: nil))
        // Whisper could not tell: not assumed to be the reader's.
        XCTAssertTrue(BauCaptionRules.onByDefault(sourceLang: "und", readerLocale: "pt-BR", stored: nil))
    }

    func testAStoredChoiceWinsEitherWay() {
        XCTAssertFalse(BauCaptionRules.onByDefault(sourceLang: "pt", readerLocale: "en", stored: false))
        XCTAssertTrue(BauCaptionRules.onByDefault(sourceLang: "pt", readerLocale: "pt", stored: true))
    }

    func testFitsWithinOneAndAHalfSeconds() {
        XCTAssertTrue(BauCaptionRules.fits(transcribedMs: 60_000, playedSeconds: 60))
        XCTAssertTrue(BauCaptionRules.fits(transcribedMs: 60_000, playedSeconds: 61.5))
        XCTAssertTrue(BauCaptionRules.fits(transcribedMs: 60_000, playedSeconds: 58.5))
        XCTAssertFalse(BauCaptionRules.fits(transcribedMs: 60_000, playedSeconds: 61.6))
        XCTAssertFalse(BauCaptionRules.fits(transcribedMs: 60_000, playedSeconds: 30))
        // Unknown on either side fits: no reason to hide anything.
        XCTAssertTrue(BauCaptionRules.fits(transcribedMs: nil, playedSeconds: 30))
        XCTAssertTrue(BauCaptionRules.fits(transcribedMs: 60_000, playedSeconds: nil))
        XCTAssertTrue(BauCaptionRules.fits(transcribedMs: 60_000, playedSeconds: 0))
    }

    // MARK: - The store

    @MainActor
    func testTheStoreRemembersTheChoiceAndHidesAMisfit() throws {
        let suite = try XCTUnwrap(UserDefaults(suiteName: "BauCaptionsTests-\(UUID().uuidString)"))
        let store = BauCaptions(defaults: suite)
        XCTAssertNil(store.stored)
        XCTAssertFalse(store.hasCaptions(for: "p"))
        XCTAssertNil(store.text(postID: "p", at: 1))

        store.seed(postID: "p", cues: [BauCaptionCue(start: 0, end: 5, text: "oi")], sourceLang: "pt", transcribedMs: 60_000)
        XCTAssertTrue(store.hasCaptions(for: "p"))
        // Reader in English, video in Portuguese: on by default.
        XCTAssertTrue(store.isOn("p", readerLocale: "en"))
        // Reader in Portuguese: off, until they press CC; then on for every video.
        XCTAssertFalse(store.isOn("p", readerLocale: "pt-BR"))
        store.toggle("p", readerLocale: "pt-BR")
        XCTAssertTrue(store.isOn("p", readerLocale: "pt-BR"))
        XCTAssertEqual(suite.object(forKey: "pqp.communityHome.captions") as? Bool, true)
        XCTAssertEqual(BauCaptions(defaults: suite).stored, true)

        // A cut of another length shows nothing, and the button goes away.
        store.noteVideoDuration(postID: "p", seconds: 20)
        XCTAssertFalse(store.hasCaptions(for: "p"))
        XCTAssertNil(store.text(postID: "p", at: 1))
        store.noteVideoDuration(postID: "p", seconds: 60.4)
        XCTAssertTrue(store.hasCaptions(for: "p"))
    }
}
