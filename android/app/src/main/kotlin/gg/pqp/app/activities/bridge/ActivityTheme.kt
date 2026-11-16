package gg.pqp.app.activities.bridge

/**
 * The design tokens an app is told about (`APP_THEME_TOKENS` in
 * `client/src/lib/apps/theme-tokens.ts`): the role tokens of docs/DESIGN.md as
 * CSS custom properties, built from the colours the phone is actually drawing
 * with, so an activity looks like part of the screen around it and follows the
 * phone into light or dark.
 *
 * An allowlist, not "every colour the app has": the app is untrusted and gets
 * only names it was always going to be given. At most 64 tokens, each at most
 * 256 characters.
 */
object ActivityTheme {
    /** The phone's colours as 0xAARRGGBB, read off `MaterialTheme.colorScheme` by the screen. */
    data class Palette(
        val dark: Boolean,
        val background: Int,
        val surface: Int,
        val surfaceRaised: Int,
        val chrome: Int,
        val border: Int,
        val onSurface: Int,
        val onSurfaceVariant: Int,
        val primary: Int,
        val primaryHover: Int,
        val onPrimary: Int,
        val danger: Int,
        val onDanger: Int,
        val warning: Int,
        val success: Int,
    )

    /** `light` or `dark`, so an app can set its own `color-scheme`. Not a pqp token: the host adds it. */
    const val COLOR_SCHEME_TOKEN = "--pqp-color-scheme"

    private const val SOFT_ALPHA = 0.16f

    fun tokens(p: Palette): Map<String, String> = linkedMapOf(
        "--color-surface-0" to hex(p.background),
        "--color-surface-1" to hex(p.surface),
        "--color-surface-2" to hex(p.surfaceRaised),
        "--color-surface-3" to hex(p.surfaceRaised),
        "--color-surface-card" to hex(p.surface),
        "--color-rail" to hex(p.chrome),
        "--color-border" to hex(p.border),
        "--color-border-strong" to hex(blend(p.border, p.onSurfaceVariant, 0.35f)),
        "--color-text" to hex(p.onSurface),
        "--color-text-secondary" to hex(p.onSurfaceVariant),
        "--color-text-tertiary" to hex(blend(p.background, p.onSurfaceVariant, 0.7f)),
        "--color-accent" to hex(p.primary),
        "--color-accent-hover" to hex(p.primaryHover),
        "--color-on-accent" to hex(p.onPrimary),
        "--color-danger" to hex(p.danger),
        "--color-on-danger" to hex(p.onDanger),
        "--color-warning" to hex(p.warning),
        "--color-success" to hex(p.success),
        "--color-accent-soft" to hex(blend(p.background, p.primary, SOFT_ALPHA)),
        "--color-on-accent-soft" to hex(p.primary),
        "--color-danger-soft" to hex(blend(p.background, p.danger, SOFT_ALPHA)),
        "--color-on-danger-soft" to hex(p.danger),
        "--color-warning-soft" to hex(blend(p.background, p.warning, SOFT_ALPHA)),
        "--color-on-warning-soft" to hex(p.warning),
        "--color-success-soft" to hex(blend(p.background, p.success, SOFT_ALPHA)),
        "--color-on-success-soft" to hex(p.success),
        "--color-focus-ring" to hex(p.primary),
        "--color-selection" to hex(blend(p.background, p.primary, 0.3f)),
        "--radius-tick" to "4px",
        "--radius-control" to "10px",
        "--radius-card" to "14px",
        "--radius-panel" to "20px",
        "--radius-pill" to "999px",
        // A sandboxed frame cannot load a font (`font-src 'self'`), so the phone's own stack is the honest answer.
        "--font-sans" to "system-ui, sans-serif",
        "--font-display" to "system-ui, sans-serif",
        COLOR_SCHEME_TOKEN to if (p.dark) "dark" else "light",
    )

    /** `#rrggbb`; the alpha channel is ignored (every token is an opaque surface or ink). */
    fun hex(argb: Int): String = String.format("#%06x", argb and 0xFFFFFF)

    /** [top] laid over [base] at [alpha], both opaque: what a translucent wash comes out as on that surface. */
    fun blend(base: Int, top: Int, alpha: Float): Int {
        fun channel(shift: Int): Int {
            val b = (base shr shift) and 0xFF
            val t = (top shr shift) and 0xFF
            return (b + (t - b) * alpha).toInt().coerceIn(0, 255)
        }
        return (0xFF shl 24) or (channel(16) shl 16) or (channel(8) shl 8) or channel(0)
    }
}
