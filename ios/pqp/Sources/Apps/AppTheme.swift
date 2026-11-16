import SwiftUI
import UIKit

/// The design tokens an app is told about in `hello` and `theme`
/// (`client/src/lib/apps/theme-tokens.ts`, docs/DESIGN.md): the role tokens, not
/// every custom property. An allowlist the app can style itself from, resolved
/// here from the phone's own `Palette` so an activity looks like the app around
/// it. The app is dark everywhere (`PqpApp` pins it), so the scheme is `dark`.
enum AppTheme {
    /// At most `AppLimits.themeMaxTokens`, each value under 256 characters.
    static func tokens() -> [String: String] {
        [
            "--color-surface-0": css(Palette.ink),
            "--color-surface-1": css(Palette.surface),
            "--color-surface-2": css(Palette.surfaceRaised),
            "--color-surface-3": css(Palette.border),
            "--color-surface-card": css(Palette.surface),
            "--color-rail": css(Palette.inkDeep),
            "--color-border": css(Palette.border),
            "--color-border-strong": css(Palette.paperMuted, alpha: 0.5),
            "--color-text": css(Palette.paper),
            "--color-text-secondary": css(Palette.paperSubtle),
            "--color-text-tertiary": css(Palette.paperMuted),
            "--color-accent": css(Palette.signal),
            "--color-accent-hover": css(Palette.signalDim),
            "--color-on-accent": css(Palette.inkDeep),
            "--color-danger": css(Palette.danger),
            "--color-on-danger": css(Palette.inkDeep),
            "--color-warning": css(Palette.warning),
            "--color-success": css(Palette.success),
            "--color-accent-soft": css(Palette.signal, alpha: 0.16),
            "--color-on-accent-soft": css(Palette.signal),
            "--color-danger-soft": css(Palette.danger, alpha: 0.16),
            "--color-on-danger-soft": css(Palette.danger),
            "--color-warning-soft": css(Palette.warning, alpha: 0.16),
            "--color-on-warning-soft": css(Palette.warning),
            "--color-success-soft": css(Palette.success, alpha: 0.16),
            "--color-on-success-soft": css(Palette.success),
            "--color-focus-ring": css(Palette.signal, alpha: 0.6),
            "--color-selection": css(Palette.signal, alpha: 0.25),
            "--radius-tick": "4px",
            "--radius-control": "10px",
            "--radius-card": "12px",
            "--radius-panel": "20px",
            "--radius-pill": "999px",
            "--font-sans": "-apple-system, system-ui, sans-serif",
            "--font-display": "ui-rounded, -apple-system, system-ui, sans-serif",
            "--pqp-color-scheme": "dark",
        ]
    }

    /// `rgb(r g b)` or `rgb(r g b / a)`, which every WebKit this app runs on reads.
    static func css(_ color: Color, alpha: Double? = nil) -> String {
        var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, a: CGFloat = 0
        UIColor(color).getRed(&red, green: &green, blue: &blue, alpha: &a)
        let r = Int((red * 255).rounded()), g = Int((green * 255).rounded()), b = Int((blue * 255).rounded())
        guard let alpha else { return "rgb(\(r) \(g) \(b))" }
        return "rgb(\(r) \(g) \(b) / \(String(format: "%.2f", alpha)))"
    }
}
