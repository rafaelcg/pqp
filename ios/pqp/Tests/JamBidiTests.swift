import XCTest
@testable import pqp

/// A person's text inside the app's own sentence. The cases are the web's
/// (`client/src/lib/bidi.test.ts`), so the three clients agree, plus what an
/// unclosed right-to-left override does to the naming a row draws.
///
/// Every character is written as an escape: a literal U+202E in a source file
/// is invisible and reorders the line it is on in an editor.
final class JamBidiTests: XCTestCase {
    private let fsi = "\u{2068}"
    private let pdi = "\u{2069}"
    private let rlo = "\u{202E}"

    func testIsolateWrapsTextInFirstStrongIsolateCharacters() {
        XCTAssertEqual(JamBidi.isolate("Gabi"), "\(fsi)Gabi\(pdi)")
        XCTAssertEqual(JamBidi.isolate("\u{0645}\u{0631}\u{062D}\u{0628}\u{0627}"), "\(fsi)\u{0645}\u{0631}\u{062D}\u{0628}\u{0627}\(pdi)")
    }

    func testEveryOverrideEmbeddingAndIsolateControlIsDroppedFirstSoTheIsolateCannotBeClosedEarly() {
        let controls = "\u{202A}\u{202B}\u{202C}\u{202D}\u{202E}\u{2066}\u{2067}\u{2068}\u{2069}"
        XCTAssertEqual(JamBidi.clean("a\u{202E}b\u{202A}c\u{202C}d\u{2067}e\u{2069}f\u{2066}g\u{2068}h\u{202B}i\u{202D}j"), "abcdefghij")
        XCTAssertEqual(JamBidi.clean(controls), "")
        XCTAssertEqual(
            JamBidi.isolate("evil\(pdi) started by you \(fsi)"),
            "\(fsi)evil started by you \(pdi)"
        )
    }

    func testTheImplicitMarksAndTheJoinersStayBecauseRealTextNeedsThem() {
        let text = "a\u{200E}b\u{200F}c\u{061C}d\u{200D}e\u{200C}f"
        XCTAssertEqual(JamBidi.clean(text), text)
        XCTAssertEqual(JamBidi.isolate(text), "\(fsi)\(text)\(pdi)")
    }

    func testHonestTextOfEveryKindDisplaysUnchanged() {
        let honest = [
            "\u{05D0}\u{05D1}\u{05D9}",  // Hebrew
            "\u{0641}\u{064A}\u{0631}\u{0648}\u{0632}",  // Arabic
            "Nguy\u{1EC5}n V\u{0103}n A",  // Vietnamese, precomposed
            "Nguye\u{0302}\u{0303}n Va\u{0306}n A",  // Vietnamese, combining marks
            "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466} fam\u{00ED}lia",  // family sequence
            "\u{1F1E7}\u{1F1F7} Brasil",  // flag
            "\u{0645}\u{0647}\u{0633}\u{0627}\u{200C}\u{0645}\u{06CC}",  // Persian with a zero width non joiner
        ]
        for text in honest {
            XCTAssertEqual(JamBidi.clean(text), text)
            XCTAssertEqual(JamBidi.isolate(text), "\(fsi)\(text)\(pdi)")
        }
    }

    func testAControlBesideACombiningMarkIsStillFound() {
        // by scalar, not by grapheme: "e" + U+202E + U+0301 would otherwise hide
        XCTAssertEqual(JamBidi.clean("e\u{202E}\u{0301}x"), "e\u{0301}x")
    }

    func testAnEmptyValueStaysEmptyAndAnAbsentOneIsEmpty() {
        XCTAssertEqual(JamBidi.isolate(""), "")
        XCTAssertEqual(JamBidi.isolate(rlo), "")
        XCTAssertEqual(JamBidi.isolateOpt(nil), "")
        XCTAssertEqual(JamBidi.isolateOpt("x"), "\(fsi)x\(pdi)")
    }

    func testCleaningWhatIsIsolatedIsCleaningTheText() {
        for text in ["Gabi", "\(rlo)Gabi", "\u{05D0}\u{05D1}"] {
            XCTAssertEqual(JamBidi.clean(JamBidi.isolate(text)), JamBidi.clean(text))
        }
    }

    // MARK: Where it lands

    private func track(label: String?, person: String?, _ instrument: JamInstrument = .bass) -> JamTrack {
        JamTrack(id: "t", songId: "s", authorId: "u", authorName: person, instrument: instrument, label: label)
    }

    func testARowNamedWithAnOverrideInItsLabelCannotReorderTheDotOrThePerson() {
        let t = track(label: "\(rlo)take 2", person: "\(rlo)Bia")
        let dot = "\u{00B7}"
        XCTAssertEqual(JamTrackNaming.caption(t), "\(fsi)take 2\(pdi) \(dot) \(fsi)Bia\(pdi)")
        XCTAssertEqual(JamTrackNaming.full(t), "Bass \(dot) \(fsi)take 2\(pdi) \(dot) \(fsi)Bia\(pdi)")
        for drawn in [JamTrackNaming.caption(t), JamTrackNaming.full(t), JamTrackNaming.chip(instrument: .bass, tracks: [t])] {
            XCTAssertFalse(drawn.contains(rlo), "the override is gone from what is drawn")
        }
    }

    func testWhatVoiceOverReadsIsPlainAndInReadingOrder() {
        let t = track(label: "\(rlo)take 2", person: "\(rlo)Bia")
        let spoken = JamTrackNaming.spoken(t)
        XCTAssertEqual(spoken, "Bass, take 2, by Bia")
        XCTAssertFalse(spoken.contains(fsi))
        XCTAssertFalse(spoken.contains(pdi))
        XCTAssertFalse(spoken.contains(rlo))
    }

    func testANameThatWasOnlyControlsIsNoNameAndLeavesNoEmptyIsolate() {
        let t = track(label: rlo, person: "\(rlo)\(pdi)")
        XCTAssertEqual(JamTrackNaming.full(t), "Bass")
        XCTAssertEqual(JamTrackNaming.caption(t), "")
        XCTAssertEqual(JamTrackNaming.spoken(t), "Bass")
    }

    func testAChipListsEachPersonAsItsOwnIsolate() {
        let many = [
            track(label: nil, person: "\(rlo)Bia"), track(label: nil, person: "Duda"),
            track(label: nil, person: "Leo"),
        ]
        XCTAssertEqual(
            JamTrackNaming.chip(instrument: .bass, tracks: many),
            "Bass \u{00B7} \(fsi)Bia\(pdi), \(fsi)Duda\(pdi) +1"
        )
    }

    func testTheWhoLineIsolatesEveryNameAndTheCleanedLineIsWhatVoiceOverGets() {
        let song = JamSongSummary(
            id: "s", channelId: "c", serverId: "x", title: "In Bloom", authorName: "\(rlo)rafa", trackCount: 2, contributorCount: 3
        )
        let line = JamWho.line(song: song, contributors: ["\(rlo)rafa", "duda"])
        XCTAssertEqual(line, "\(fsi)rafa\(pdi), \(fsi)duda\(pdi) +1")
        XCTAssertEqual(JamBidi.clean(line), "rafa, duda +1")
        XCTAssertEqual(JamWho.line(song: song, contributors: nil), "\(fsi)rafa\(pdi) +2")
    }

    func testAnAuthorWhoseNameWasOnlyControlsIsNotDrawnSoItIsNotSubtractedFromTheCount() {
        let song = JamSongSummary(
            id: "s", channelId: "c", serverId: "x", title: "In Bloom", authorName: rlo, trackCount: 2, contributorCount: 3
        )
        XCTAssertEqual(JamWho.line(song: song, contributors: nil), "+3")
    }

    // MARK: The avatar's initial

    func testAnAvatarNameThatStartsWithAnOverrideStillHasAnInitial() {
        // Before: the first character of "\u{202E}Bia" is the override, which draws as nothing.
        XCTAssertEqual(Avatar.initials(of: "\(rlo)Bia"), "\(rlo)")
        let t = track(label: nil, person: "\(rlo)Bia Souza")
        XCTAssertEqual(t.avatarName, "Bia Souza")
        XCTAssertEqual(Avatar.initials(of: t.avatarName), "BS")
    }

    func testEveryControlIsDroppedFromTheAvatarName() {
        let t = track(label: nil, person: "\u{202A}\u{2067}Leo\u{202C}\u{2069} Lima")
        XCTAssertEqual(t.avatarName, "Leo Lima")
        XCTAssertEqual(Avatar.initials(of: t.avatarName), "LL")
    }

    func testAnAvatarNameOfOnlyControlsFallsBackToTheQuestionMark() {
        let t = track(label: nil, person: "\(rlo)\u{2066}")
        XCTAssertEqual(t.avatarName, "")
        XCTAssertEqual(Avatar.initials(of: t.avatarName), "?")
        // An account that is gone has no name at all.
        XCTAssertEqual(track(label: nil, person: nil).avatarName, "?")
    }

    func testAnOrdinaryNameIsUntouchedByTheAvatarClean() {
        XCTAssertEqual(track(label: nil, person: "Gabi").avatarName, "Gabi")
        XCTAssertEqual(track(label: nil, person: "\u{0645}\u{0631}\u{062D}\u{0628}\u{0627}").avatarName, "\u{0645}\u{0631}\u{062D}\u{0628}\u{0627}")
    }

    // MARK: A song link that cannot open

    func testASongOfAnotherJamDoesNotOpenUnderThisOne() {
        let song = JamSongSummary(id: "s", channelId: "jam-1", serverId: "x", title: "In Bloom", trackCount: 1, contributorCount: 1)
        XCTAssertTrue(JamSongLinkRules.belongs(song, toChannel: "jam-1"))
        XCTAssertFalse(JamSongLinkRules.belongs(song, toChannel: "jam-2"))
    }

    func testGoneAndHiddenAreUnavailableAndEverythingElseIsTryAgain() {
        XCTAssertTrue(JamSongLinkMessage.isUnavailable(APIError.notFound("Song not found")))
        XCTAssertTrue(JamSongLinkMessage.isUnavailable(APIError.server(status: 403, message: "no")))
        XCTAssertFalse(JamSongLinkMessage.isUnavailable(APIError.server(status: 500, message: "boom")))
        XCTAssertFalse(JamSongLinkMessage.isUnavailable(APIError.transport("offline")))
        XCTAssertFalse(JamSongLinkMessage.isUnavailable(URLError(.notConnectedToInternet)))
        XCTAssertEqual(JamSongLinkMessage.forFailure(APIError.notFound("x")), JamSongLinkMessage.unavailable)
        XCTAssertEqual(JamSongLinkMessage.forFailure(APIError.transport("x")), JamSongLinkMessage.failed)
    }
}
