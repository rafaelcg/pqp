import UIKit
import XCTest
@testable import pqp

/// A shared screen in a voice room or a call turns with the phone.
///
/// THE BUG. The app is locked to portrait everywhere except the watch party
/// (`WatchOrientation`), and the fullscreen of a shared screen never asked for
/// the unlock. Its own doc even said so ("the app is portrait-only, so this
/// letterboxes rather than rotating"), so a viewer in an ordinary voice
/// channel could fill the screen with a laptop's 16:9 picture and then hold
/// the phone sideways to no effect. These pin the rules that fix it: landscape
/// is held by exactly the stages that fill the screen, each under its own
/// owner, and nothing else in the app inherits it.
@MainActor
final class ScreenShareLandscapeTests: XCTestCase {

    override func setUp() async throws {
        try await super.setUp()
        reset()
    }

    override func tearDown() async throws {
        reset()
        try await super.tearDown()
    }

    private func reset() {
        WatchOrientation.leaveTheater()
        WatchOrientation.releaseAllScreenShares()
    }

    private var isPhone: Bool { UIDevice.current.userInterfaceIdiom == .phone }

    private func assertLocked(_ message: String = "", file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertFalse(WatchOrientation.isUnlocked, message, file: file, line: line)
        if isPhone {
            XCTAssertEqual(WatchOrientation.allowed, .portrait, message, file: file, line: line)
        }
    }

    private func assertUnlocked(_ message: String = "", file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(WatchOrientation.isUnlocked, message, file: file, line: line)
        XCTAssertTrue(WatchOrientation.allowed.contains(.landscapeLeft), message, file: file, line: line)
        XCTAssertTrue(WatchOrientation.allowed.contains(.landscapeRight), message, file: file, line: line)
    }

    // MARK: - The owners

    func testNothingOnScreenMeansPortrait() {
        assertLocked("the lock is the default, everywhere that is not a stage")
        XCTAssertEqual(WatchOrientation.ownerCount, 0)
    }

    func testAFullscreenShareUnlocksLandscapeAndLeavingLocksThePhoneBack() {
        let stage = UUID()
        WatchOrientation.enterScreenShare(stage)
        assertUnlocked()
        XCTAssertTrue(WatchOrientation.holds(.screenShare(stage)))
        WatchOrientation.leaveScreenShare(stage)
        assertLocked("leaving the fullscreen has to put the rest of the app back")
    }

    func testEnteringTwiceAndLeavingOnceIsStillOneClaimReleased() {
        let stage = UUID()
        WatchOrientation.enterScreenShare(stage)
        WatchOrientation.enterScreenShare(stage)
        XCTAssertEqual(WatchOrientation.ownerCount, 1, "onAppear can fire twice; that is one stage")
        WatchOrientation.leaveScreenShare(stage)
        assertLocked("a counter would have stayed unlocked here")
    }

    func testLeavingWhatWasNeverEnteredDoesNothing() {
        WatchOrientation.leaveScreenShare(UUID())
        WatchOrientation.leaveScreenShare(UUID())
        assertLocked()
        XCTAssertEqual(WatchOrientation.ownerCount, 0, "unbalanced leaves must not go negative")
        // And a real stage afterwards is unaffected by the strays.
        let stage = UUID()
        WatchOrientation.enterScreenShare(stage)
        assertUnlocked()
        WatchOrientation.leaveScreenShare(stage)
        assertLocked()
    }

    func testAVoiceRoomAndACallDoNotReleaseEachOther() {
        let room = UUID()
        let call = UUID()
        WatchOrientation.enterScreenShare(room)
        WatchOrientation.enterScreenShare(call)
        WatchOrientation.leaveScreenShare(room)
        assertUnlocked("the call's fullscreen is still on screen")
        WatchOrientation.leaveScreenShare(call)
        assertLocked()
    }

    /// The two never share a screen, but a watch party's own `onDisappear`
    /// and a share's can land in either order around a room switch.
    func testWatchPartyAndAShareDoNotLockEachOtherOut() {
        let stage = UUID()
        WatchOrientation.enterTheater()
        WatchOrientation.enterScreenShare(stage)
        WatchOrientation.leaveTheater()
        assertUnlocked("the share is still fullscreen")
        WatchOrientation.leaveScreenShare(stage)
        assertLocked()

        WatchOrientation.enterScreenShare(stage)
        WatchOrientation.enterTheater()
        WatchOrientation.leaveScreenShare(stage)
        assertUnlocked("the watch party is still on screen")
        WatchOrientation.leaveTheater()
        assertLocked()
    }

    func testTheWatchPartysUnbalancedLeavesStillBehaveAsTheyAlwaysDid() {
        // `WatchStageView` calls `leaveTheater()` from its disappear, its
        // seat change and its phase change, none of them balanced against an
        // enter. That is the reason this is a set and not a count.
        WatchOrientation.leaveTheater()
        WatchOrientation.leaveTheater()
        WatchOrientation.enterTheater()
        assertUnlocked()
        WatchOrientation.leaveTheater()
        WatchOrientation.leaveTheater()
        assertLocked()
    }

    // MARK: - The net under it

    /// The room or the call ends with the fullscreen up, so the cover goes
    /// with its presenter and may never run its own disappear.
    func testReleaseAllShareClaimsDropsEveryShareAndOnlyThose() {
        WatchOrientation.enterScreenShare(UUID())
        WatchOrientation.enterScreenShare(UUID())
        WatchOrientation.enterTheater()
        WatchOrientation.releaseAllScreenShares()
        XCTAssertEqual(WatchOrientation.ownerCount, 1)
        XCTAssertTrue(WatchOrientation.holds(.watchParty), "a film on screen is not a share's to release")
        WatchOrientation.leaveTheater()
        assertLocked()
    }

    func testReleaseAllWithNothingHeldIsHarmless() {
        WatchOrientation.releaseAllScreenShares()
        assertLocked()
    }

    // MARK: - What UIKit is asked

    private var sources: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .appending(path: "Sources")
    }

    private func source(_ path: String) throws -> String {
        try String(contentsOf: sources.appending(path: path), encoding: .utf8)
    }

    func testTheAppDelegateStillAnswersWithTheOwners() throws {
        let push = try source("Core/PushNotifications.swift")
        XCTAssertTrue(push.contains("supportedInterfaceOrientationsFor"))
        XCTAssertTrue(
            push.contains("WatchOrientation.allowed"),
            "UIKit only ever asks the delegate; if it stops reading the owners nothing rotates"
        )
        let chrome = try source("Voice/WatchChrome.swift")
        XCTAssertTrue(
            chrome.contains("if isUnlocked { return .allButUpsideDown }"),
            "the mask follows the owners, whoever they are"
        )
    }

    func testInfoPlistListsLandscapeSoIOSWillRotateAtAll() throws {
        let plist = sources.deletingLastPathComponent().appending(path: "Info.plist")
        let text = try String(contentsOf: plist, encoding: .utf8)
        XCTAssertTrue(text.contains("UIInterfaceOrientationLandscapeLeft"))
        XCTAssertTrue(text.contains("UIInterfaceOrientationLandscapeRight"))
    }

    // MARK: - The view

    func testTheFullscreenHoldsTheUnlockExactlyWhileItIsOnScreen() throws {
        let views = try source("Voice/ScreenShareViews.swift")
        guard let start = views.range(of: "struct ScreenShareFullscreenView") else {
            return XCTFail("the fullscreen share is gone")
        }
        let body = String(views[start.lowerBound...])
        XCTAssertTrue(body.contains("@State private var stageID = UUID()"), "one claim per presentation")
        XCTAssertTrue(body.contains(".onAppear { WatchOrientation.enterScreenShare(stageID) }"))
        XCTAssertTrue(body.contains(".onDisappear { WatchOrientation.leaveScreenShare(stageID) }"))
    }

    /// A branch on the orientation swaps the renderer's view and the track is
    /// re-attached: a black flash, and on LiveKit a re-subscribe's worth of
    /// work. The picture has to be the same view with a new frame.
    func testRotatingGivesTheSameSurfaceANewFrameAndNothingBranchesOnIt() throws {
        let views = try source("Voice/ScreenShareViews.swift")
        guard let start = views.range(of: "struct ScreenShareFullscreenView"),
              let end = views.range(of: "struct ScreenSharePresenterBanner")
        else { return XCTFail("could not bound the fullscreen share") }
        let body = String(views[start.lowerBound..<end.lowerBound])
        for forbidden in ["isLandscape", "verticalSizeClass", "horizontalSizeClass", "GeometryReader", "UIDevice"] {
            XCTAssertFalse(
                body.contains(forbidden),
                "\(forbidden): the fullscreen must not rebuild itself when the phone turns"
            )
        }
        XCTAssertTrue(body.contains("contentMode: .scaleAspectFit"), "a share is letterboxed, never cropped")
        XCTAssertTrue(
            body.contains(".ignoresSafeArea(.container, edges: .vertical)"),
            "the picture must stay out from under the island and the notch on its side"
        )
        XCTAssertEqual(
            body.components(separatedBy: "VideoSurface(").count - 1, 1,
            "one surface: a second would be a second renderer on the same track"
        )
    }

    /// The lock is deliberately portrait everywhere else, so the only callers
    /// of the unlock are the two stages that fill the screen.
    func testNothingButAStageEverUnlocksLandscape() throws {
        let fm = FileManager.default
        let enumerator = fm.enumerator(at: sources, includingPropertiesForKeys: nil)
        var callers: Set<String> = []
        while let url = enumerator?.nextObject() as? URL {
            guard url.pathExtension == "swift" else { continue }
            let text = try String(contentsOf: url, encoding: .utf8)
            if text.contains("WatchOrientation.enterScreenShare(") || text.contains("WatchOrientation.enterTheater()") {
                callers.insert(url.lastPathComponent)
            }
        }
        XCTAssertEqual(callers, ["ScreenShareViews.swift", "WatchStageView.swift"])
    }

    func testTheRootDropsAStrandedShareClaimWhenNoShareIsLeft() throws {
        let app = try source("App/PqpApp.swift")
        XCTAssertTrue(app.contains("voice.remoteScreen == nil && call.remoteScreen == nil"))
        XCTAssertTrue(app.contains("WatchOrientation.releaseAllScreenShares()"))
    }
}
