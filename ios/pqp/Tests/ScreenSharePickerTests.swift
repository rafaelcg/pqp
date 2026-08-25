import ReplayKit
import SwiftUI
import UIKit
import XCTest
@testable import pqp

/// The share control's *hit target*, which is the half of screen sharing that
/// no other test can see.
///
/// WHY THIS EXISTS. Starting a broadcast is Apple's decision, taken in Apple's
/// sheet, from a tap on Apple's own `UIButton` buried inside
/// `RPSystemBroadcastPickerView`. We paint a circle over that button and let
/// the touch fall through. Nothing in that arrangement is checked by the
/// compiler, and its failure mode is the worst one a control has: it looks
/// exactly right and does nothing at all, which is what a TestFlight tester
/// reported against build 12.
///
/// Two specific things go wrong silently, and both are measured here rather
/// than reasoned about:
///
///  - **Apple's button is not where the view is.** Measured, it lands at
///    `(5, 5)` with the picker's *full* width and height, so inside 62x62
///    bounds it runs from 5 to 67. Intersected with the bounds that hit-test,
///    the live area is a 57x57 square in the bottom-right corner and the top
///    and left edges of our circle are dead. `alignHitTarget` pins it back.
///  - **UIKit will not hit-test a view at alpha 0.01 or less.** The picker has
///    to be invisible and touchable at the same time, which is a two-decimal
///    margin, and SwiftUI's `.opacity` multiplies down the tree: an ancestor
///    dimming a control to 0.4 takes 0.02 to 0.008 and kills it outright.
///
/// These assertions are about *our* composition, not about ReplayKit: whether
/// iOS then finds the extension and opens its sheet is device-only and cannot
/// be reached from here.
final class ScreenSharePickerTests: XCTestCase {
    /// Every point of the painted control must reach Apple's button.
    ///
    /// Sampled on a grid including the corners, because the bug being pinned is
    /// specifically an offset that leaves the middle working and the edges dead:
    /// a centre-only assertion passes against the broken layout.
    @MainActor
    func testEveryPointOfTheControlHitsApplesButton() {
        for side in [CGFloat(60), CGFloat(62)] {
            let (window, host) = present(
                ScreenShareControlButton(isSharing: false, identifier: "voice.share", side: side)
            )
            defer { window.isHidden = true }

            guard let picker = Self.findPicker(in: host.view) else {
                return XCTFail("no RPSystemBroadcastPickerView in the hierarchy at side \(side)")
            }
            XCTAssertEqual(picker.bounds.width, side, accuracy: 0.5,
                           "the picker must be the size of the circle we paint")

            let steps = 6
            for row in 0...steps {
                for column in 0...steps {
                    // Inset by a hair so the far edge samples inside the bounds
                    // rather than exactly on the exclusive boundary.
                    let point = CGPoint(
                        x: min(CGFloat(column) / CGFloat(steps) * side, side - 0.5),
                        y: min(CGFloat(row) / CGFloat(steps) * side, side - 0.5)
                    )
                    let hit = window.hitTest(picker.convert(point, to: window), with: nil)
                    XCTAssertTrue(
                        hit is UIButton,
                        "tap at \(point) on a \(side)pt control hit \(hit.map { "\(type(of: $0))" } ?? "nothing")"
                    )
                }
            }
        }
    }

    /// The picker's own alpha is what UIKit tests, and it must clear the floor
    /// on its own rather than depending on what SwiftUI does above it.
    @MainActor
    func testPickerStaysTouchableUnderAnAncestorThatDimsIt() {
        // Exactly what `VoiceView` does while the room is still connecting.
        let (window, host) = present(
            ScreenShareControlButton(isSharing: false, identifier: "voice.share", side: 60)
                .opacity(0.4)
        )
        defer { window.isHidden = true }

        guard let picker = Self.findPicker(in: host.view) else {
            return XCTFail("no RPSystemBroadcastPickerView in the hierarchy")
        }
        XCTAssertGreaterThan(
            picker.alpha, 0.01,
            "UIKit refuses to hit-test at 0.01 or below, so this margin is the control"
        )
        let centre = CGPoint(x: picker.bounds.midX, y: picker.bounds.midY)
        XCTAssertTrue(
            window.hitTest(picker.convert(centre, to: window), with: nil) is UIButton,
            "a dimmed ancestor must not take the control away"
        )
    }

    /// The tap has to be observable, or a share that never starts is
    /// indistinguishable from a button nobody pressed.
    @MainActor
    func testApplesButtonCarriesOurOwnTapTarget() {
        var taps = 0
        let (window, host) = present(
            ScreenShareControlButton(
                isSharing: false,
                identifier: "voice.share",
                onTap: { taps += 1 }
            )
        )
        defer { window.isHidden = true }

        guard let picker = Self.findPicker(in: host.view),
              let button = picker.subviews.compactMap({ $0 as? UIButton }).first else {
            return XCTFail("no button inside the picker")
        }
        button.sendActions(for: .touchUpInside)
        XCTAssertEqual(taps, 1, "the app must hear its own control being used")
    }

    // MARK: - Harness

    @MainActor
    private func present(_ view: some View) -> (UIWindow, UIViewController) {
        let host = UIHostingController(rootView: view)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        window.rootViewController = host
        window.isHidden = false
        window.layoutIfNeeded()
        host.view.setNeedsLayout()
        host.view.layoutIfNeeded()
        return (window, host)
    }

    @MainActor
    private static func findPicker(in view: UIView) -> RPSystemBroadcastPickerView? {
        if let picker = view as? RPSystemBroadcastPickerView { return picker }
        for subview in view.subviews {
            if let found = findPicker(in: subview) { return found }
        }
        return nil
    }
}
