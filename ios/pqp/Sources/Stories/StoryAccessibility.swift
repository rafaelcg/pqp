import SwiftUI

extension View {
    /// A picture that says nothing a label beside it does not already say (an
    /// icon on a button that has its own name, the glyph over a tile): out of
    /// the accessibility tree, for good.
    ///
    /// `accessibilityHidden(true)` alone is not enough for the test tree: the
    /// node stays in XCUITest's element snapshot, an `Image` named after its
    /// SF Symbol ("Audiolivro", "Conectar", `camera.metering.unknown` when the
    /// symbol has no localized description), which is also what any tool that
    /// reads the tree sees. Hiding it AND giving it an empty accessibility
    /// representation leaves no node at all. Use it on an icon only when
    /// something else carries the name: a button's own label, or the text next
    /// to it.
    func decorative() -> some View {
        accessibilityHidden(true)
            .accessibilityRepresentation { EmptyView() }
    }
}
