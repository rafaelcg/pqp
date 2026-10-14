import PencilKit
import UIKit
import XCTest
@testable import pqp

/// Layers: the wire shapes from `packages/shared/src/stories.ts`, the one
/// geometry rule the editor and the viewer share, the snapping, and the
/// editor's state (a drag, a pinch, a twist, the bin, undo, the limits).
@MainActor
final class StoryLayersTests: XCTestCase {
    private let id1 = "11111111-1111-4111-8111-111111111111"
    private let id2 = "22222222-2222-4222-8222-222222222222"
    private let id3 = "33333333-3333-4333-8333-333333333333"
    private let user = "44444444-4444-4444-8444-444444444444"
    private let canvas = CGSize(width: 360, height: 640)

    private func decodeLayers(_ json: String) throws -> [StoryLayer] {
        try Coding.decoder.decode(StoryLayerList.self, from: Data(json.utf8)).layers
    }

    private func textLayer(_ text: String = "oi", x: Double = 0.5, y: Double = 0.5) -> StoryLayer {
        StoryLayer(x: x, y: y, content: .text(StoryTextData(text: text)))
    }

    // MARK: - Decoding

    func testEveryLayerTypeDecodes() throws {
        let layers = try decodeLayers("""
        [
         {"id":"\(id1)","type":"text","x":0.5,"y":0.3,"scale":1.5,"rotation":0.2,"text":"bora","font":"serif","color":"lime","background":"solid","align":"left","size":2},
         {"id":"\(id2)","type":"image","x":0.4,"y":0.6,"scale":1,"rotation":0,"shape":"circle","url":"https://x.y/a.jpg","width":720,"height":1280},
         {"id":"\(id3)","type":"call","x":0.5,"y":0.8,"scale":1,"rotation":0,"serverId":"\(user)","channelId":"\(id1)"},
         {"id":"a","type":"mention","x":0.5,"y":0.2,"scale":1,"rotation":0,"userId":"\(user)","user":{"id":"\(user)","displayName":"Bia Souza","avatarUrl":null,"handle":"bia"}},
         {"id":"b","type":"drawing","x":0.5,"y":0.5,"scale":1,"rotation":0,"url":"https://x.y/d.png","width":810,"height":1440}
        ]
        """)
        XCTAssertEqual(layers.map(\.typeName), ["text", "image", "call", "mention", "drawing"])
        guard case .text(let text) = layers[0].content else { return XCTFail("text") }
        XCTAssertEqual(text, StoryTextData(text: "bora", font: .serif, color: .lime, background: .solid, align: .left, size: 2))
        XCTAssertEqual(layers[0].scale, 1.5)
        guard case .image(let picture) = layers[1].content else { return XCTFail("image") }
        XCTAssertEqual(picture.shape, .circle)
        XCTAssertEqual(picture.url, "https://x.y/a.jpg")
        guard case .mention(_, let person) = layers[3].content else { return XCTFail("mention") }
        XCTAssertEqual(person?.handle, "bia")
        XCTAssertTrue(layers[4].isDrawing)
    }

    /// A story is never refused, and a viewer never crashes, because of one
    /// layer: unknown types and broken fields are skipped, order kept.
    func testWhatThisBuildCannotReadIsSkippedAndTheRestKeepsOrder() throws {
        let layers = try decodeLayers("""
        [
         {"id":"\(id1)","type":"text","x":0.5,"y":0.5,"scale":1,"rotation":0,"text":"um"},
         {"id":"\(id2)","type":"poll","x":0.5,"y":0.5,"scale":1,"rotation":0,"question":"?"},
         "not even an object",
         {"id":"\(id3)","type":"image","x":0.5,"y":0.5,"scale":1,"rotation":0},
         {"id":"z","type":"text","x":0.5,"y":0.5,"scale":1,"rotation":0,"text":"dois"}
        ]
        """)
        XCTAssertEqual(layers.map(\.id), [id1, "z"])
    }

    /// A value a later server adds (a sixth font) must not cost the layer.
    func testAnUnknownEnumValueFallsBackToTheDefault() throws {
        let layers = try decodeLayers("""
        [{"id":"\(id1)","type":"text","x":0.5,"y":0.5,"scale":1,"rotation":0,"text":"oi","font":"comic","color":"mauve","align":"justify"}]
        """)
        guard case .text(let text) = layers[0].content else { return XCTFail("text") }
        XCTAssertEqual(text.font, .classic)
        XCTAssertEqual(text.color, .white)
        XCTAssertEqual(text.align, .center)
    }

    func testAStoryReadsItsLayersAndAltText() throws {
        func story(_ tail: String) -> Data {
            Data("""
            {"id":"\(id1)","author":{"id":"\(user)","displayName":"Bia","avatarUrl":null},"kind":"image","caption":null,"text":null,"background":null,
             "media":{"url":"https://x.y/a.jpg","posterUrl":null,"contentType":"image/jpeg","width":720,"height":1280,"durationMs":null},
             "sticker":null,"call":null,"publishedAt":null,"expiresAt":null,"audiences":[],
             "viewer":{"seen":false,"reaction":null,"canReply":false,"replyBlockedReason":null,"canModerate":[]},"own":null\(tail)}
            """.utf8)
        }
        let layer = #"{"id":"\#(id1)","type":"text","x":0.5,"y":0.5,"scale":1,"rotation":0,"text":"bora"}"#
        let read = try Coding.decoder.decode(Story.self, from: story(#","altText":"bora jogar","layers":[\#(layer)]"#))
        XCTAssertEqual(read.layers.count, 1)
        XCTAssertEqual(read.altText, "bora jogar")
        // An older server sends neither.
        let before = try Coding.decoder.decode(Story.self, from: story(""))
        XCTAssertEqual(before.layers, [])
        XCTAssertNil(before.altText)
        // And the cache can write it back out.
        _ = try JSONEncoder().encode(read)
    }

    func testTheConfigKnowsWhetherTheServerHasLayers() throws {
        let off = try Coding.decoder.decode(StoriesConfig.self, from: Data(#"{"enabled":true,"friendsEnabled":false,"mediaEnabled":true,"videoEnabled":true,"maxVideoMs":30000,"maxBytes":100}"#.utf8))
        XCTAssertFalse(off.layersEnabled)
        let on = try Coding.decoder.decode(StoriesConfig.self, from: Data(#"{"enabled":true,"friendsEnabled":false,"mediaEnabled":true,"videoEnabled":true,"maxVideoMs":30000,"maxBytes":100,"layersMax":20}"#.utf8))
        XCTAssertTrue(on.layersEnabled)
    }

    // MARK: - Encoding

    func testACreateLayerIsClampedAndCarriesItsUploadNotAKey() throws {
        let wild = StoryLayer(id: id1, x: 1.4, y: -0.2, scale: 9, rotation: 7, content: .image(StoryLayerPicture(url: nil, width: 800, height: 600, shape: .circle)))
        let input = StoryLayerInput(layer: wild, upload: StoryLayerUploadDeclaration(contentType: "image/jpeg", byteSize: 1234, width: 800, height: 600))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(input)) as? [String: Any])
        XCTAssertEqual(object["type"] as? String, "image")
        XCTAssertEqual(object["x"] as? Double, 1)
        XCTAssertEqual(object["y"] as? Double, 0)
        XCTAssertEqual(object["scale"] as? Double, 5)
        XCTAssertLessThanOrEqual(abs(try XCTUnwrap(object["rotation"] as? Double)), StoryLayerLimits.rotationMax)
        XCTAssertEqual(object["shape"] as? String, "circle")
        let upload = try XCTUnwrap(object["upload"] as? [String: Any])
        XCTAssertEqual(upload["byteSize"] as? Int, 1234)
        XCTAssertNil(object["url"])
        XCTAssertNil(object["mediaKey"])
    }

    func testATextLayerIsTrimmedAndKeepsItsStyle() throws {
        var data = StoryTextData(text: "  bora  \n", font: .neon, color: .pink, background: .soft, align: .right, size: 9)
        data.size = 9
        let input = StoryLayerInput(layer: StoryLayer(id: id1, content: .text(data)), upload: nil)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(input)) as? [String: Any])
        XCTAssertEqual(object["text"] as? String, "bora")
        XCTAssertEqual(object["font"] as? String, "neon")
        XCTAssertEqual(object["color"] as? String, "pink")
        XCTAssertEqual(object["background"] as? String, "soft")
        XCTAssertEqual(object["align"] as? String, "right")
        XCTAssertEqual(object["size"] as? Double, 3, "Size is held to the contract's 0.5 to 3")
    }

    // MARK: - Geometry

    func testRotationIsNormalizedIntoMinusPiToPi() {
        XCTAssertEqual(StoryCanvas.normalizedRotation(.pi * 2), 0, accuracy: 1e-9)
        XCTAssertEqual(StoryCanvas.normalizedRotation(.pi * 1.5), -.pi / 2, accuracy: 1e-9)
        XCTAssertEqual(StoryCanvas.normalizedRotation(-.pi * 1.5), .pi / 2, accuracy: 1e-9)
        XCTAssertLessThanOrEqual(abs(StoryCanvas.normalizedRotation(40)), .pi)
    }

    /// A layer turned a quarter and enlarged is hit where it is DRAWN.
    func testAHitGoesThroughTheLayersOwnRotationAndScale() {
        // 200 wide, 40 tall, centered, turned 90 degrees: now 40 wide, 200 tall.
        let layer = StoryLayer(x: 0.5, y: 0.5, rotation: .pi / 2, content: .text(StoryTextData(text: "x")))
        let size = CGSize(width: 200, height: 40)
        let center = CGPoint(x: 180, y: 320)
        XCTAssertTrue(StoryCanvas.hit(layer, size: size, at: center, canvas: canvas))
        XCTAssertTrue(StoryCanvas.hit(layer, size: size, at: CGPoint(x: 180, y: 320 + 90), canvas: canvas), "Along the turned length")
        XCTAssertFalse(StoryCanvas.hit(layer, size: size, at: CGPoint(x: 180 + 90, y: 320), canvas: canvas), "Where it was before it turned")
        var big = layer
        big.rotation = 0
        big.scale = 2
        XCTAssertTrue(StoryCanvas.hit(big, size: size, at: CGPoint(x: 180 + 190, y: 320), canvas: canvas), "Scale widens the target")
    }

    func testTheTopmostLayerWinsAndTheDrawingIsNeverPicked() {
        let under = StoryLayer(id: id1, content: .text(StoryTextData(text: "a")))
        let over = StoryLayer(id: id2, content: .text(StoryTextData(text: "b")))
        let drawing = StoryLayer(id: id3, content: .drawing(StoryLayerPicture(url: nil, width: 810, height: 1440)))
        let sizes = [id1: CGSize(width: 100, height: 40), id2: CGSize(width: 100, height: 40), id3: CGSize(width: 360, height: 640)]
        let hit = StoryCanvas.topmost([under, drawing, over], sizes: sizes, at: CGPoint(x: 180, y: 320), canvas: canvas)
        XCTAssertEqual(hit?.id, id2)
        XCTAssertNil(StoryCanvas.topmost([drawing], sizes: sizes, at: CGPoint(x: 180, y: 320), canvas: canvas), "A drawing is not a thing you can grab")
        XCTAssertNil(StoryCanvas.topmost([under], sizes: sizes, at: CGPoint(x: 5, y: 5), canvas: canvas))
    }

    func testPicturesAreFortyPercentOfTheWidthAtScaleOne() {
        let size = StoryCanvas.pictureSize(StoryLayerPicture(url: nil, width: 800, height: 400), canvasWidth: 400)
        XCTAssertEqual(size.width, 160)
        XCTAssertEqual(size.height, 80)
    }

    /// Web is the reference; `STORY_LAYOUT` and `STORY_TEXT_COLOR_HEX` in
    /// `packages/shared/src/stories.ts` are the same numbers. A story must look
    /// the same on every platform, so a change here is a change there.
    func testTheLayoutConstantsMatchTheSharedReference() {
        XCTAssertEqual(StoryCanvas.textFontFraction, 0.08)
        XCTAssertEqual(StoryCanvas.textMaxWidthFraction, 0.84)
        XCTAssertEqual(StoryCanvas.textLineHeight, 1.14)
        XCTAssertEqual(StoryCanvas.imageWidthFraction, 0.40)
        XCTAssertEqual(StoryCanvas.mentionFontFraction, 0.05)
        XCTAssertEqual(StoryCanvas.stickerWidthFraction, 0.82)
        XCTAssertEqual(StoryDrawingExport.pixelWidth, 810)
    }

    func testTheTextPaletteIsTheSharedHexes() {
        let expected: [StoryTextColor: UInt32] = [
            .white: 0xFFFFFF, .black: 0x000000, .lime: 0xBBEC4C, .yellow: 0xFFD60A, .orange: 0xFF9500, .red: 0xFF3B30,
            .pink: 0xFF5FA2, .purple: 0xAF52DE, .blue: 0x0A84FF, .cyan: 0x64D2FF, .green: 0x30D158, .gray: 0x8E8E93,
        ]
        for color in StoryTextColor.allCases { XCTAssertEqual(color.hex, expected[color], "\(color)") }
        XCTAssertEqual(expected.count, StoryTextColor.allCases.count)
    }

    func testAPictureFillsWithinTwelvePercentOfNineBySixteen() {
        XCTAssertTrue(StoryCanvas.fillsCanvas(width: 1080, height: 1920))
        XCTAssertTrue(StoryCanvas.fillsCanvas(width: 1080, height: 2160), "1:2 (0.5) is within 12%")
        XCTAssertFalse(StoryCanvas.fillsCanvas(width: 1170, height: 2532), "A phone screenshot (0.462) is not")
        XCTAssertFalse(StoryCanvas.fillsCanvas(width: 1080, height: 1350), "4:5 is not")
        XCTAssertFalse(StoryCanvas.fillsCanvas(width: 1920, height: 1080))
    }

    // MARK: - Snapping

    func testTheCenterLinesPullAndLetGo() {
        let near = StorySnap.position(x: 0.505, y: 0.2, canvas: canvas)
        XCTAssertTrue(near.snappedX)
        XCTAssertEqual(near.x, 0.5)
        XCTAssertFalse(near.snappedY)
        XCTAssertEqual(near.y, 0.2)
        let far = StorySnap.position(x: 0.54, y: 0.5, canvas: canvas)
        XCTAssertFalse(far.snappedX, "14 pt away is outside the pull")
        XCTAssertTrue(far.snappedY)
    }

    func testRotationSticksToTheRightAngles() {
        XCTAssertEqual(StorySnap.rotation(0.04).angle, 0)
        XCTAssertTrue(StorySnap.rotation(0.04).snapped)
        XCTAssertEqual(StorySnap.rotation(.pi / 2 + 0.05).angle, .pi / 2)
        XCTAssertEqual(StorySnap.rotation(-.pi / 2 + 0.05).angle, -.pi / 2)
        XCTAssertFalse(StorySnap.rotation(0.3).snapped)
        XCTAssertEqual(StorySnap.rotation(0.3).angle, 0.3, accuracy: 1e-9)
    }

    func testTheBinSitsAtTheBottomCenter() {
        let frame = StorySnap.trashFrame(canvas: canvas)
        XCTAssertEqual(frame.midX, 180, accuracy: 0.5)
        XCTAssertGreaterThan(frame.midY, canvas.height * 0.85)
        XCTAssertTrue(StorySnap.isOverTrash(CGPoint(x: frame.midX, y: frame.midY), canvas: canvas))
        XCTAssertTrue(StorySnap.isOverTrash(CGPoint(x: frame.midX + 50, y: frame.midY), canvas: canvas), "Generous around it")
        XCTAssertFalse(StorySnap.isOverTrash(CGPoint(x: 180, y: 300), canvas: canvas))
    }

    // MARK: - The editor

    private func editor(with layers: [StoryLayer] = []) -> StoryEditorModel {
        let model = StoryEditorModel()
        model.canvas = canvas
        for layer in layers {
            if case .text(let data) = layer.content { model.addText(data) }
        }
        for layer in model.layers { model.sizes[layer.id] = CGSize(width: 120, height: 40) }
        return model
    }

    func testAddingTextPlacesItAndSelectsIt() {
        let model = editor()
        let id = model.addText(StoryTextData(text: "bora"))
        XCTAssertNotNil(id)
        XCTAssertEqual(model.layers.count, 1)
        XCTAssertEqual(model.selectedId, id)
        XCTAssertEqual(model.layers[0].x, 0.5)
        XCTAssertTrue(model.canUndo)
    }

    func testDraggingMovesAndSnapsToTheCenterWithATick() {
        let model = editor(with: [textLayer()])
        var ticks = 0
        model.onSnap = { ticks += 1 }
        XCTAssertTrue(model.beginGesture(at: CGPoint(x: 180, y: 320)))
        model.drag(translation: CGSize(width: 90, height: 100), touch: CGPoint(x: 270, y: 420))
        XCTAssertEqual(model.layers[0].x, 0.75, accuracy: 0.001)
        XCTAssertEqual(model.layers[0].y, 0.5 + 100.0 / 640, accuracy: 0.001)
        XCTAssertEqual(ticks, 0)
        // Back near the middle: sticks, ticks once, however many moves it takes.
        model.drag(translation: CGSize(width: 2, height: 100), touch: CGPoint(x: 182, y: 420))
        model.drag(translation: CGSize(width: 1, height: 100), touch: CGPoint(x: 181, y: 420))
        XCTAssertEqual(model.layers[0].x, 0.5)
        XCTAssertTrue(model.guides.vertical)
        XCTAssertEqual(ticks, 1)
        model.endGesture()
        XCTAssertFalse(model.guides.vertical)
        XCTAssertEqual(model.layers[0].x, 0.5)
    }

    func testAFingerBesideNothingPicksNothing() {
        let model = editor(with: [textLayer()])
        XCTAssertFalse(model.beginGesture(at: CGPoint(x: 10, y: 10)))
        model.drag(translation: CGSize(width: 50, height: 50), touch: .zero)
        XCTAssertEqual(model.layers[0].x, 0.5)
    }

    func testPinchAndTwistScaleAndTurnAtTheSameTimeWithinTheBounds() {
        let model = editor(with: [textLayer()])
        XCTAssertTrue(model.beginGestureOnSelection(at: CGPoint(x: 180, y: 320)))
        model.beginPinch()
        model.beginRotation()
        model.pinch(scale: 2)
        model.rotate(by: 0.5)
        XCTAssertEqual(model.layers[0].scale, 2, accuracy: 0.001)
        XCTAssertEqual(model.layers[0].rotation, 0.5, accuracy: 0.001)
        model.pinch(scale: 100)
        XCTAssertEqual(model.layers[0].scale, StoryLayerLimits.scaleMax)
        model.pinch(scale: 0.001)
        XCTAssertEqual(model.layers[0].scale, StoryLayerLimits.scaleMin)
        model.endGesture()
    }

    func testAPinchWithFingersBesideASmallLayerStillScalesThePickedOne() {
        let model = editor(with: [textLayer()])
        model.selectedId = model.layers[0].id
        // Fingers land far from the 120x40 layer.
        XCTAssertTrue(model.beginGestureOnSelection(at: CGPoint(x: 20, y: 600)))
        model.beginPinch()
        model.pinch(scale: 1.5)
        XCTAssertEqual(model.layers[0].scale, 1.5, accuracy: 0.001)
        model.endGesture()
    }

    func testRotationSnapsToStraightWithATick() {
        let model = editor(with: [textLayer()])
        var ticks = 0
        model.onSnap = { ticks += 1 }
        _ = model.beginGestureOnSelection(at: CGPoint(x: 180, y: 320))
        model.beginRotation()
        model.rotate(by: 0.3)
        XCTAssertEqual(model.layers[0].rotation, 0.3, accuracy: 1e-9)
        model.rotate(by: 0.04)
        XCTAssertEqual(model.layers[0].rotation, 0.04 > StorySnap.angle ? 0.04 : 0, accuracy: 1e-9)
        XCTAssertEqual(ticks, 1)
        XCTAssertTrue(model.guides.rotation)
        model.endGesture()
    }

    func testDroppingOnTheBinDeletesAndTheBinIsUndoable() {
        let model = editor(with: [textLayer()])
        var deleted = 0
        var entered = 0
        model.onDelete = { deleted += 1 }
        model.onTrashEnter = { entered += 1 }
        let bin = StorySnap.trashFrame(canvas: canvas)
        _ = model.beginGesture(at: CGPoint(x: 180, y: 320))
        model.drag(translation: CGSize(width: 0, height: 300), touch: CGPoint(x: bin.midX, y: bin.midY))
        XCTAssertTrue(model.overTrash)
        XCTAssertEqual(entered, 1)
        model.endGesture()
        XCTAssertEqual(deleted, 1)
        XCTAssertTrue(model.layers.isEmpty)
        model.undo()
        XCTAssertEqual(model.layers.count, 1, "Undo brings it back where it was")
        XCTAssertEqual(model.layers[0].y, 0.5, accuracy: 0.001)
    }

    func testLiftingOverTheBinOnlyIfTheFingerLeftItIsAMove() {
        let model = editor(with: [textLayer()])
        let bin = StorySnap.trashFrame(canvas: canvas)
        _ = model.beginGesture(at: CGPoint(x: 180, y: 320))
        model.drag(translation: CGSize(width: 0, height: 300), touch: CGPoint(x: bin.midX, y: bin.midY))
        model.drag(translation: CGSize(width: 60, height: 100), touch: CGPoint(x: 240, y: 420))
        XCTAssertFalse(model.overTrash)
        model.endGesture()
        XCTAssertEqual(model.layers.count, 1)
    }

    func testUndoWalksBackThroughMovesAndEdits() {
        let model = editor()
        let id = model.addText(StoryTextData(text: "um"))!
        model.sizes[id] = CGSize(width: 100, height: 40)
        _ = model.beginGesture(at: CGPoint(x: 180, y: 320 + 0.0))
        model.drag(translation: CGSize(width: 60, height: 0), touch: .zero)
        model.endGesture()
        model.updateText(id: id, StoryTextData(text: "dois"))
        guard case .text(let edited)? = model.layer(id)?.content else { return XCTFail() }
        XCTAssertEqual(edited.text, "dois")
        model.undo()
        guard case .text(let back)? = model.layer(id)?.content else { return XCTFail() }
        XCTAssertEqual(back.text, "um")
        model.undo()
        XCTAssertEqual(model.layer(id)?.x ?? 0, 0.5, accuracy: 0.001)
        model.undo()
        XCTAssertTrue(model.layers.isEmpty)
        XCTAssertFalse(model.canUndo)
    }

    func testUndoIsBoundedToTheLastFewActions() {
        let model = editor()
        for index in 0..<(StoryEditorModel.undoDepth + 5) { model.addText(StoryTextData(text: "n\(index)")) }
        var steps = 0
        while model.canUndo { model.undo(); steps += 1 }
        XCTAssertEqual(steps, StoryEditorModel.undoDepth)
    }

    func testTheLimitsAreEnforcedPerType() {
        let model = editor()
        let png = StoryLayerFile(data: Data([1, 2, 3]), contentType: "image/jpeg", width: 100, height: 100)
        let image = UIImage()
        for _ in 0..<StoryLayerLimits.images { XCTAssertNotNil(model.addImage(png, preview: image)) }
        XCTAssertNil(model.addImage(png, preview: image), "Six photos is the most")
        XCTAssertNotNil(model.addCall(serverId: id1, channelId: id2, info: StoryCallLayerInfo(roomName: "Lobby", serverName: "QG", serverIconUrl: nil)))
        XCTAssertNil(model.addCall(serverId: id1, channelId: id3, info: StoryCallLayerInfo(roomName: "x", serverName: "QG", serverIconUrl: nil)), "One call")
        let person = StoryAuthor(id: user, displayName: "Bia", avatarUrl: nil)
        XCTAssertNotNil(model.addMention(userId: user, user: person))
        XCTAssertNil(model.addMention(userId: user, user: person), "Each person once")
    }

    func testTwentyLayersIsTheCeiling() {
        let model = editor()
        for index in 0..<StoryLayerLimits.max { XCTAssertNotNil(model.addText(StoryTextData(text: "n\(index)"))) }
        XCTAssertTrue(model.isFull)
        XCTAssertNil(model.addText(StoryTextData(text: "one more")))
    }

    func testTheDrawingIsOneLayerReplacedAndSitsUnderTheText() {
        let model = editor()
        model.addText(StoryTextData(text: "titulo"))
        let file = StoryLayerFile(data: Data([1]), contentType: "image/png", width: 810, height: 1440)
        var strokes = PKDrawing()
        strokes.strokes.append(PKStroke(ink: PKInk(.pen, color: .white), path: PKStrokePath(controlPoints: [
            PKStrokePoint(location: .zero, timeOffset: 0, size: CGSize(width: 4, height: 4), opacity: 1, force: 1, azimuth: 0, altitude: 0),
            PKStrokePoint(location: CGPoint(x: 20, y: 20), timeOffset: 0.1, size: CGSize(width: 4, height: 4), opacity: 1, force: 1, azimuth: 0, altitude: 0),
        ], creationDate: Date())))
        model.setDrawing(strokes, file: file, preview: UIImage())
        XCTAssertEqual(model.layers.map(\.typeName), ["text", "drawing"], "A new drawing goes on top: layer order is creation order")
        model.setDrawing(strokes, file: file, preview: UIImage())
        XCTAssertEqual(model.layers.filter(\.isDrawing).count, 1)
        model.addText(StoryTextData(text: "depois"))
        model.setDrawing(strokes, file: file, preview: UIImage())
        XCTAssertEqual(model.layers.map(\.typeName), ["text", "drawing", "text"], "Drawing again keeps the drawing's place in the order")
        model.setDrawing(PKDrawing(), file: nil, preview: nil)
        XCTAssertEqual(model.layers.map(\.typeName), ["text", "text"], "Clearing the strokes removes the layer")
        XCTAssertTrue(model.files.isEmpty)
    }

    /// The rule web and Android share: layer order is creation order, and a
    /// second drawing session moves the drawing to the top, so the stroke made
    /// now stays over what the finger sees after Pronto.
    func testASecondDrawingSessionBringsTheDrawingToTheTop() {
        let model = editor()
        let file = StoryLayerFile(data: Data([1]), contentType: "image/png", width: 810, height: 1440)
        var strokes = PKDrawing()
        strokes.strokes.append(PKStroke(ink: PKInk(.pen, color: .white), path: PKStrokePath(controlPoints: [
            PKStrokePoint(location: .zero, timeOffset: 0, size: CGSize(width: 4, height: 4), opacity: 1, force: 1, azimuth: 0, altitude: 0),
            PKStrokePoint(location: CGPoint(x: 20, y: 20), timeOffset: 0.1, size: CGSize(width: 4, height: 4), opacity: 1, force: 1, azimuth: 0, altitude: 0),
        ], creationDate: Date())))
        model.beginDrawing()
        XCTAssertFalse(model.canUndo, "No drawing yet: nothing to move")
        model.setDrawing(strokes, file: file, preview: UIImage())
        model.addText(StoryTextData(text: "por cima"))
        XCTAssertEqual(model.layers.map(\.typeName), ["drawing", "text"])
        model.beginDrawing()
        XCTAssertEqual(model.layers.map(\.typeName), ["text", "drawing"], "The pen goes down over the text")
        model.setDrawing(strokes, file: file, preview: UIImage())
        XCTAssertEqual(model.layers.map(\.typeName), ["text", "drawing"], "Pronto keeps it there")
        model.undo()
        model.undo()
        XCTAssertEqual(model.layers.map(\.typeName), ["drawing", "text"], "Undo puts the order back")
        model.beginDrawing()
        model.beginDrawing()
        XCTAssertEqual(model.layers.map(\.typeName), ["text", "drawing"], "Already on top: no second step")
    }

    func testDeletingALayerDropsItsBytesAndUndoBringsThemBack() {
        let model = editor()
        let file = StoryLayerFile(data: Data([1]), contentType: "image/jpeg", width: 10, height: 10)
        let id = model.addImage(file, preview: UIImage())!
        XCTAssertNotNil(model.files[id])
        model.delete(id: id)
        XCTAssertNil(model.files[id])
        XCTAssertNil(model.previews[id])
        model.undo()
        XCTAssertEqual(model.layers.count, 1)
        XCTAssertEqual(model.files[id]?.data, Data([1]), "The photo comes back with its bytes, so it draws and uploads")
        XCTAssertNotNil(model.previews[id])
    }

    func testUndoBringsBackADeletedCallWithItsCard() {
        let model = editor()
        let id = model.addCall(serverId: id1, channelId: id2, info: StoryCallLayerInfo(roomName: "Lobby", serverName: "QG", serverIconUrl: nil))!
        model.delete(id: id)
        XCTAssertNil(model.callInfo)
        model.undo()
        XCTAssertEqual(model.callInfo?.roomName, "Lobby")
    }

    /// The system cutting a gesture off (an alert, a call) rolls it back; being
    /// cut off over the bin must not delete.
    func testACancelledGestureOverTheBinDeletesNothingAndMovesNothing() {
        let model = editor(with: [textLayer()])
        let bin = StorySnap.trashFrame(canvas: canvas)
        _ = model.beginGesture(at: CGPoint(x: 180, y: 320))
        model.drag(translation: CGSize(width: 0, height: 300), touch: CGPoint(x: bin.midX, y: bin.midY))
        XCTAssertTrue(model.overTrash)
        model.cancelGesture()
        XCTAssertEqual(model.layers.count, 1)
        XCTAssertEqual(model.layers[0].y, 0.5, accuracy: 0.001, "Back where it was")
        XCTAssertFalse(model.overTrash)
        XCTAssertNil(model.activeId)
    }

    // MARK: - Reading what the server and the cache give back

    /// A `null` or a scalar in the list is skipped and the layer after it is
    /// kept; a cursor that never moved would loop for ever on the `null`.
    func testNullsAndScalarsInTheListAreSteppedOver() throws {
        let layers = try decodeLayers("""
        [null, 7, "x", {"id":"a","type":"text","x":0.5,"y":0.5,"scale":1,"rotation":0,"text":"um"}, null,
         {"id":"b","type":"poll","x":0.5,"y":0.5,"scale":1,"rotation":0},
         {"id":"c","type":"text","x":0.5,"y":0.5,"scale":1,"rotation":0,"text":"dois"}]
        """)
        XCTAssertEqual(layers.map(\.id), ["a", "c"])
    }

    /// The read cache writes a story back out and reads it again: picture and
    /// mention layers have to survive the round trip.
    func testAStoryKeepsItsLayersThroughTheCache() throws {
        let json = """
        {"id":"\(id1)","author":{"id":"\(user)","displayName":"Bia","avatarUrl":null},"kind":"image","caption":null,"text":null,"background":null,
         "media":{"url":"https://x.y/a.jpg","posterUrl":null,"contentType":"image/jpeg","width":720,"height":1280,"durationMs":null},
         "sticker":null,"call":null,"publishedAt":null,"expiresAt":null,"audiences":[],
         "viewer":{"seen":false,"reaction":null,"canReply":false,"replyBlockedReason":null,"canModerate":[]},"own":null,
         "layers":[
          {"id":"a","type":"image","x":0.4,"y":0.6,"scale":1.2,"rotation":0.1,"shape":"circle","url":"https://x.y/p.jpg","width":720,"height":1280},
          {"id":"b","type":"drawing","x":0.5,"y":0.5,"scale":1,"rotation":0,"url":"https://x.y/d.png","width":810,"height":1440},
          {"id":"c","type":"mention","x":0.5,"y":0.2,"scale":1,"rotation":0,"userId":"\(user)","user":{"id":"\(user)","displayName":"Bia Souza","avatarUrl":null,"handle":"bia"}},
          {"id":"d","type":"call","x":0.5,"y":0.8,"scale":1,"rotation":0,"serverId":"\(id2)","channelId":"\(id3)"},
          {"id":"e","type":"text","x":0.5,"y":0.3,"scale":1,"rotation":0,"text":"oi","font":"neon","color":"pink"}]}
        """
        let story = try Coding.decoder.decode(Story.self, from: Data(json.utf8))
        XCTAssertEqual(story.layers.count, 5)
        let written = try Coding.encoder.encode(story)
        let again = try Coding.decoder.decode(Story.self, from: written)
        XCTAssertEqual(again.layers, story.layers, "Nothing is lost on the way through the cache")
    }

    // MARK: - Editing text in place

    func testANewLineStartsWhereTheToolOpenedAndWithTheChosenScale() {
        let model = editor()
        let start = model.nextTextCenter()
        let id = model.addText(StoryTextData(text: "oi"), x: start.x, y: start.y, scale: 2.5)!
        XCTAssertEqual(model.layer(id)?.x, start.x)
        XCTAssertEqual(model.layer(id)?.y, start.y)
        XCTAssertEqual(model.layer(id)?.scale, 2.5)
        let second = model.nextTextCenter()
        XCTAssertGreaterThan(second.y, start.y, "The next line starts a little lower")
    }

    /// Done on an edited line is ONE undo step for the words, the style and
    /// the scale together, and the place and the angle are never touched.
    func testDoneOnAnEditedLineIsOneUndoStepAndMovesNothing() {
        let model = editor()
        let id = model.addText(StoryTextData(text: "um"), x: 0.3, y: 0.6, scale: 1)!
        _ = model.beginGesture(at: CGPoint(x: 0.3 * canvas.width, y: 0.6 * canvas.height))
        model.sizes[id] = CGSize(width: 100, height: 40)
        model.endGesture()
        guard var layer = model.layer(id) else { return XCTFail() }
        var edited = StoryTextData(text: "um dois")
        edited.color = .lime
        model.commitText(id: id, edited, scale: 2)
        layer = model.layer(id)!
        XCTAssertEqual(layer.x, 0.3)
        XCTAssertEqual(layer.y, 0.6)
        XCTAssertEqual(layer.rotation, 0)
        XCTAssertEqual(layer.scale, 2)
        guard case .text(let data) = layer.content else { return XCTFail() }
        XCTAssertEqual(data.text, "um dois")
        XCTAssertEqual(data.color, .lime)
        model.undo()
        guard case .text(let back)? = model.layer(id)?.content else { return XCTFail() }
        XCTAssertEqual(back.text, "um", "One undo reverts the words, the color and the scale")
        XCTAssertEqual(model.layer(id)?.scale, 1)
    }

    func testDoneWithNothingChangedRecordsNothing() {
        let model = editor()
        let id = model.addText(StoryTextData(text: "um"))!
        let layer = model.layer(id)!
        if case .text(let data) = layer.content { model.commitText(id: id, data, scale: layer.scale) }
        model.undo()
        XCTAssertTrue(model.layers.isEmpty, "The only step on the stack is the add: Done with nothing changed is not an action")
    }

    func testTheScaleASliderChoosesStaysInsideTheContract() {
        let model = editor()
        let id = model.addText(StoryTextData(text: "um"))!
        model.commitText(id: id, StoryTextData(text: "um"), scale: 99)
        XCTAssertEqual(model.layer(id)?.scale, StoryLayerLimits.scaleMax)
        model.commitText(id: id, StoryTextData(text: "um"), scale: 0.001)
        XCTAssertEqual(model.layer(id)?.scale, StoryLayerLimits.scaleMin)
    }

    func testBringToFrontReorders() {
        let model = editor()
        let first = model.addText(StoryTextData(text: "a"))!
        _ = model.addText(StoryTextData(text: "b"))
        model.bringToFront(id: first)
        XCTAssertEqual(model.layers.last?.id, first)
        model.sendToBack(id: first)
        XCTAssertEqual(model.layers.first?.id, first)
    }

    func testNudgeAndResizeStayInBounds() {
        let model = editor()
        let id = model.addText(StoryTextData(text: "a"))!
        model.nudge(id: id, dx: 5, dy: -5)
        XCTAssertEqual(model.layer(id)?.x, 1)
        XCTAssertEqual(model.layer(id)?.y, 0)
        for _ in 0..<30 { model.resize(id: id, by: 1.3) }
        XCTAssertEqual(model.layer(id)?.scale, StoryLayerLimits.scaleMax)
    }

    // MARK: - Alt text, mentions

    func testAltTextReadsTopToBottomAndIsCapped() {
        let low = StoryLayer(x: 0.5, y: 0.9, content: .text(StoryTextData(text: "embaixo")))
        let high = StoryLayer(x: 0.5, y: 0.1, content: .text(StoryTextData(text: "em cima")))
        let call = StoryLayer(x: 0.5, y: 0.5, content: .call(serverId: id1, channelId: id2))
        let text = StoryAltText.make(layers: [low, call, high], callRoomName: "Lobby", caption: nil)
        XCTAssertEqual(text, "em cima. \(String(localized: "Call: Lobby")). embaixo")
        XCTAssertNil(StoryAltText.make(layers: [], callRoomName: nil, caption: nil))
        let long = StoryLayer(content: .text(StoryTextData(text: String(repeating: "a", count: 280))))
        XCTAssertLessThanOrEqual(StoryAltText.make(layers: [long, long, long], callRoomName: nil, caption: nil)?.count ?? 0, StoryLayerLimits.altTextMax)
    }

    func testMentionCandidatesAreFriendsThenMembersEachOnceNeverMe() {
        func person(_ id: String, _ name: String) -> StoryMentionCandidate {
            StoryMentionCandidate(id: id, displayName: name, handle: nil, avatarUrl: nil)
        }
        let shown = StoryMentionRules.candidates(
            friends: [person("a", "Ana"), person("me", "Eu")],
            members: [person("a", "Ana"), person("b", "Bia"), person("c", "Caio")],
            me: "me", taken: ["c"], query: ""
        )
        XCTAssertEqual(shown.map(\.id), ["a", "b"])
        XCTAssertEqual(StoryMentionRules.candidates(friends: [], members: [person("b", "Bia")], me: nil, taken: [], query: "BI").map(\.id), ["b"])
        XCTAssertTrue(StoryMentionRules.candidates(friends: [], members: [person("b", "Bia")], me: nil, taken: [], query: "zz").isEmpty)
    }

    func testEveryTextColorHasALabelAndAContrastRule() {
        for color in StoryTextColor.allCases { XCTAssertFalse(color.label.isEmpty) }
        XCTAssertEqual(StoryTextColor.allCases.count, 12)
        XCTAssertTrue(StoryTextColor.white.isLight)
        XCTAssertFalse(StoryTextColor.black.isLight)
    }

    func testTheDrawingExportsAsATransparentPNGAtTheCanvasAspect() throws {
        var strokes = PKDrawing()
        strokes.strokes.append(PKStroke(ink: PKInk(.pen, color: .red), path: PKStrokePath(controlPoints: [
            PKStrokePoint(location: CGPoint(x: 10, y: 10), timeOffset: 0, size: CGSize(width: 8, height: 8), opacity: 1, force: 1, azimuth: 0, altitude: 0),
            PKStrokePoint(location: CGPoint(x: 200, y: 300), timeOffset: 0.2, size: CGSize(width: 8, height: 8), opacity: 1, force: 1, azimuth: 0, altitude: 0),
        ], creationDate: Date())))
        let png = try XCTUnwrap(StoryDrawingExport.png(strokes, canvas: canvas))
        XCTAssertEqual(png.width, 810)
        XCTAssertEqual(png.height, 1440)
        XCTAssertEqual(Array(png.data.prefix(4)), [0x89, 0x50, 0x4E, 0x47], "A PNG")
        XCTAssertLessThanOrEqual(png.data.count, StoryLayerLimits.maxBytes)
        let image = try XCTUnwrap(UIImage(data: png.data)?.cgImage)
        XCTAssertTrue([.premultipliedLast, .premultipliedFirst, .last, .first].contains(image.alphaInfo), "Keeps its alpha")
        XCTAssertNil(StoryDrawingExport.png(PKDrawing(), canvas: canvas), "No strokes, no file")
    }
}
