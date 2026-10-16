import SwiftUI
import XCTest
@testable import pqp

/// Stories, the web's 2026-10-15 additions: the solid and gradient text card
/// backgrounds, and author-written alt text (`alt` on a placed photo, the base
/// picture's description first in `altText`).
@MainActor
final class StoryBackgroundsAltTests: XCTestCase {
    private let id1 = "11111111-1111-4111-8111-111111111111"
    private let id2 = "22222222-2222-4222-8222-222222222222"

    // MARK: - Backgrounds: the contract

    /// The key lists are `packages/shared/src/stories.ts`'s, read from the
    /// repo itself, so a key added there without a colour here fails this test
    /// instead of drawing the default card on every phone.
    private func sharedList(_ name: String) throws -> [String] {
        // ios/pqp/Tests/<this file>: three levels up is `ios`, one more the repo.
        let repo = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let source = repo.appendingPathComponent("packages/shared/src/stories.ts")
        guard let text = try? String(contentsOf: source, encoding: .utf8) else {
            throw XCTSkip("packages/shared is not reachable from this test process")
        }
        let pattern = "export const \(name) = \\[([^\\]]*)\\]"
        let match = try XCTUnwrap(text.range(of: pattern, options: .regularExpression), "\(name) is not in stories.ts")
        let body = String(text[match])
        return body.components(separatedBy: "\"").enumerated().filter { $0.offset % 2 == 1 }.map(\.element)
    }

    func testTheThreeFamiliesAreTheContractsAndKeepTheirOrder() throws {
        XCTAssertEqual(StoryRules.backgrounds, try sharedList("STORY_BACKGROUNDS"))
        XCTAssertEqual(StoryRules.solidBackgrounds, try sharedList("STORY_BACKGROUNDS_SOLID"))
        XCTAssertEqual(StoryRules.gradientBackgrounds, try sharedList("STORY_BACKGROUNDS_GRADIENT"))
        XCTAssertEqual(
            StoryRules.cardBackgrounds,
            StoryRules.backgrounds + StoryRules.solidBackgrounds + StoryRules.gradientBackgrounds
        )
    }

    func testEveryKeyHasItsOwnColoursAndOnlyAnUnknownOneFallsBack() {
        let fallback = StoryRules.backgroundColors("no-such-key")
        for key in StoryRules.cardBackgrounds where key != "ink" {
            XCTAssertNotEqual(StoryRules.backgroundColors(key), fallback, "\(key) draws the default card")
            XCTAssertEqual(StoryRules.backgroundColors(key).count, 2)
        }
        XCTAssertEqual(StoryRules.backgroundColors("ink"), fallback, "ink is the default card")
        XCTAssertEqual(StoryRules.backgroundColors(nil), fallback)
    }

    func testASolidIsOneColourTwiceAndAGradientIsTwoDifferentStops() {
        for key in StoryRules.solidBackgrounds {
            let colors = StoryRules.backgroundColors(key)
            XCTAssertEqual(colors[0], colors[1], "\(key) is flat")
        }
        for key in StoryRules.gradientBackgrounds {
            let colors = StoryRules.backgroundColors(key)
            XCTAssertNotEqual(colors[0], colors[1], "\(key) has two stops")
        }
    }

    func testTheNameOfEveryKeyIsNotTheFallback() {
        for key in StoryRules.cardBackgrounds where key != "ink" {
            XCTAssertNotEqual(StoryEditorView.backgroundName(key), StoryEditorView.backgroundName("no-such-key"), key)
        }
    }

    func testTheNewKeysTravelAsTheyAre() throws {
        let request = CreateStoryRequest(
            kind: "text", text: "bora", background: "sunset",
            audiences: StoryAudienceTargets(serverIds: [], friends: true)
        )
        let body = try Coding.encoder.encode(request)
        XCTAssertTrue(String(decoding: body, as: UTF8.self).contains("\"background\":\"sunset\""))
    }

    // MARK: - Alt text

    private func decode(_ json: String) throws -> [StoryLayer] {
        try Coding.decoder.decode(StoryLayerList.self, from: Data(json.utf8)).layers
    }

    func testAPlacedPhotosAltIsReadAndAMissingOneIsNone() throws {
        let layers = try decode("""
        [{"id":"\(id1)","type":"image","x":0.5,"y":0.5,"scale":1,"rotation":0,"shape":"rect","alt":"um cachorro  na praia","url":"https://x.y/a.jpg","width":720,"height":1280},
         {"id":"\(id2)","type":"image","x":0.5,"y":0.5,"scale":1,"rotation":0,"shape":"rect","alt":null,"url":"https://x.y/b.jpg","width":720,"height":1280}]
        """)
        guard case .image(let first) = layers[0].content, case .image(let second) = layers[1].content else {
            return XCTFail("images")
        }
        XCTAssertEqual(first.alt, "um cachorro na praia", "whitespace collapsed")
        XCTAssertNil(second.alt)
        XCTAssertTrue(layers[0].spokenLabel.contains("um cachorro na praia"))
        XCTAssertEqual(layers[1].spokenLabel, String(localized: "Photo"))
    }

    func testTheCacheKeepsTheAlt() throws {
        let layer = StoryLayer(id: id1, content: .image(StoryLayerPicture(url: "https://x.y/a.jpg", width: 10, height: 20, alt: "um gato")))
        let data = try Coding.encoder.encode([layer])
        let back = try decode(String(decoding: data, as: UTF8.self))
        guard case .image(let picture) = back[0].content else { return XCTFail("image") }
        XCTAssertEqual(picture.alt, "um gato")
    }

    func testTheCreateRequestCarriesAltOnlyWhenWrittenAndNeverOverTheLimit() throws {
        let upload = StoryLayerUploadDeclaration(contentType: "image/jpeg", byteSize: 10, width: 10, height: 20)
        func json(_ alt: String?) throws -> String {
            let layer = StoryLayer(id: id1, content: .image(StoryLayerPicture(url: nil, width: 10, height: 20, alt: alt)))
            return String(decoding: try Coding.encoder.encode(StoryLayerInput(layer: layer, upload: upload)), as: UTF8.self)
        }
        XCTAssertFalse(try json(nil).contains("\"alt\""))
        XCTAssertFalse(try json("   \n ").contains("\"alt\""), "an empty description is not sent")
        XCTAssertTrue(try json("  um   gato ").contains("\"alt\":\"um gato\""))
        let long = String(repeating: "a", count: 500)
        let sent = try json(long)
        XCTAssertTrue(sent.contains(String(repeating: "a", count: StoryLayerLimits.altMax)))
        XCTAssertFalse(sent.contains(String(repeating: "a", count: StoryLayerLimits.altMax + 1)))
    }

    func testThePictureDescriptionComesFirstThenPlacedPhotosThenTheWords() {
        let photoLow = StoryLayer(x: 0.5, y: 0.8, content: .image(StoryLayerPicture(url: nil, width: 1, height: 1, alt: "foto de baixo")))
        let photoHigh = StoryLayer(x: 0.5, y: 0.2, content: .image(StoryLayerPicture(url: nil, width: 1, height: 1, alt: "foto de cima")))
        let words = StoryLayer(x: 0.5, y: 0.5, content: .text(StoryTextData(text: "bora")))
        let text = StoryAltText.make(layers: [photoLow, words, photoHigh], callRoomName: nil, caption: "legenda", baseAlt: "  a praia ao  pôr do sol ")
        XCTAssertEqual(text, "a praia ao pôr do sol. foto de cima. foto de baixo. bora. legenda")
    }

    func testWithNothingWrittenTheAltIsWhatItWas() {
        let words = StoryLayer(x: 0.5, y: 0.5, content: .text(StoryTextData(text: "bora")))
        XCTAssertEqual(StoryAltText.make(layers: [words], callRoomName: nil, caption: nil), "bora")
        XCTAssertNil(StoryAltText.make(layers: [], callRoomName: nil, caption: nil, baseAlt: "  "))
    }

    func testTheDescriptionIsCappedLikeTheStoryAltText() {
        let text = StoryAltText.make(
            layers: [], callRoomName: nil, caption: nil, baseAlt: String(repeating: "b", count: 400)
        )
        XCTAssertLessThanOrEqual(text?.count ?? 0, StoryLayerLimits.altTextMax)
        XCTAssertEqual(StoryAltText.clean(String(repeating: "x", count: 300))?.count, StoryLayerLimits.altMax)
    }

    func testTheLimitCountsUTF16UnitsLikeTheContractAndNeverCutsACharacter() {
        // 101 emoji are 101 characters and 202 units: over the contract's 200.
        let capped = StoryAltText.capped(String(repeating: "\u{1F600}", count: 101))
        XCTAssertEqual(capped.count, 100)
        XCTAssertLessThanOrEqual(capped.utf16.count, StoryLayerLimits.altMax)
        XCTAssertEqual(StoryAltText.capped("abc"), "abc")
        XCTAssertEqual(StoryAltText.remaining("abc"), StoryLayerLimits.altMax - 3)
    }

    func testASpokenPhraseIsAWholePhraseNotLettersInsideOtherWords() {
        XCTAssertTrue(StoryAltText.says("um gato", in: "a praia. um gato. bora"))
        XCTAssertTrue(StoryAltText.says("art", in: "art"))
        XCTAssertFalse(StoryAltText.says("art", in: "party"))
        XCTAssertTrue(StoryAltText.says("art", in: "party. art. fim"))
    }

    func testUndoingSomethingElseKeepsADescriptionAddedAfterIt() throws {
        let model = StoryEditorModel()
        model.canvas = CGSize(width: 360, height: 640)
        let photo = try XCTUnwrap(model.addImage(
            StoryLayerFile(data: Data([1]), contentType: "image/jpeg", width: 10, height: 20), preview: UIImage()
        ))
        _ = try XCTUnwrap(model.addText(StoryTextData(text: "oi")))
        model.setAlt(id: photo, alt: "um gato")
        model.undo()
        guard case .image(let picture)? = model.layer(photo)?.content else { return XCTFail("the photo is still there") }
        XCTAssertEqual(picture.alt, "um gato")
    }

    func testTheEditorKeepsADescriptionOnAPhotoNotOnAText() throws {
        let model = StoryEditorModel()
        model.canvas = CGSize(width: 360, height: 640)
        let photo = try XCTUnwrap(model.addImage(
            StoryLayerFile(data: Data([1]), contentType: "image/jpeg", width: 10, height: 20), preview: UIImage()
        ))
        let words = try XCTUnwrap(model.addText(StoryTextData(text: "oi")))
        model.setAlt(id: photo, alt: "  um   gato ")
        model.setAlt(id: words, alt: "ignored")
        guard case .image(let picture)? = model.layer(photo)?.content else { return XCTFail("image") }
        XCTAssertEqual(picture.alt, "um gato")
        guard case .text(let data)? = model.layer(words)?.content else { return XCTFail("text") }
        XCTAssertEqual(data.text, "oi")
        model.baseAlt = "a praia"
        model.clear()
        XCTAssertEqual(model.baseAlt, "", "a cleared editor describes nothing")
    }

    func testAPhotoTheAuthorDescribedIsSpokenInTheViewerOnlyWhenTheStoryDoesNotAlready() throws {
        let layer = StoryLayer(content: .image(StoryLayerPicture(url: "https://x.y/a.jpg", width: 1, height: 1, alt: "um gato")))
        func story(altText: String?) throws -> Story {
            let alt = altText.map { "\"\($0)\"" } ?? "null"
            let json = """
            {"id":"\(id1)","author":{"id":"\(id2)","displayName":"Bia Souza","avatarUrl":null,"handle":null},
             "kind":"image","caption":null,"text":null,"background":null,
             "media":{"url":"https://x.y/a.jpg","posterUrl":null,"contentType":"image/jpeg","width":720,"height":1280,"durationMs":null},
             "sticker":null,"call":null,
             "publishedAt":"2026-10-12T10:00:00.000Z","expiresAt":"2026-10-13T10:00:00.000Z",
             "audiences":[],"viewer":{"seen":false,"reaction":null,"canReply":false,"replyBlockedReason":null,"canModerate":[]},
             "own":null,"altText":\(alt)}
            """
            return try Coding.decoder.decode(Story.self, from: Data(json.utf8))
        }
        XCTAssertTrue(layer.hasUnspokenAlt(in: try story(altText: nil)))
        XCTAssertFalse(layer.hasUnspokenAlt(in: try story(altText: "a praia. um gato. bora")), "the story already says it")
        XCTAssertFalse(StoryLayer(content: .text(StoryTextData(text: "x"))).hasUnspokenAlt(in: try story(altText: nil)))
    }
}
