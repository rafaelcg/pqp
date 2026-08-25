package gg.pqp.app.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/**
 * The pqp palette, carried over from `client/src/index.css` by way of
 * `ios/pqp/Sources/Design/Theme.swift`, which already did the oklch to sRGB
 * conversion. Same numbers, so the three clients are one product rather than
 * three things that look similar.
 */
object Palette {
    val Ink = Color(0xFF090E12)
    val InkDeep = Color(0xFF05080C)
    val Surface = Color(0xFF12181D)
    val SurfaceRaised = Color(0xFF1C2329)
    val Border = Color(0xFF2B343C)

    /** The one loud colour. Sparingly, and never behind long-form text. */
    val Signal = Color(0xFFBBEC4C)
    val SignalDim = Color(0xFF92BF35)

    val Paper = Color(0xFFF0EEE8)
    val PaperMuted = Color(0xFFB6B4AF)
    val PaperSubtle = Color(0xFFD3D0CB)

    val Danger = Color(0xFFEF5350)
    val Warning = Color(0xFFF9BF49)
    val Success = Color(0xFF66D475)

    // The light scheme's counterparts, from the `:root` block the web app uses
    // when the reader has asked for light. The signal darkens there, because a
    // colour that reads as a highlight on ink reads as a highlighter pen on
    // paper.
    val LightSignal = Color(0xFF5F8A28)
    val LightSignalDim = Color(0xFF4E7420)
    val LightGround = Color(0xFFFBFAF7)
    val LightSurface = Color(0xFFFFFFFF)
    val LightSurfaceRaised = Color(0xFFF2F1EC)
    val LightBorder = Color(0xFFDCDAD3)
    val LightInk = Color(0xFF14181C)
    val LightInkMuted = Color(0xFF5A6068)
}

/**
 * Deliberately not Material You.
 *
 * Dynamic colour would repaint the one thing this product is recognised by, and
 * pqp's whole visual identity is a lime signal on near-black. The Android feel
 * comes from the components, the motion and the navigation, which are Material 3
 * throughout; it does not have to come from the wallpaper. Discord and Slack
 * make the same call on this platform.
 */
private val DarkColors = darkColorScheme(
    primary = Palette.Signal,
    onPrimary = Palette.Ink,
    primaryContainer = Palette.SignalDim,
    onPrimaryContainer = Palette.Ink,
    secondary = Palette.PaperSubtle,
    onSecondary = Palette.Ink,
    secondaryContainer = Palette.SurfaceRaised,
    onSecondaryContainer = Palette.Paper,
    tertiary = Palette.Signal,
    onTertiary = Palette.Ink,
    background = Palette.Ink,
    onBackground = Palette.Paper,
    surface = Palette.Ink,
    onSurface = Palette.Paper,
    surfaceVariant = Palette.Surface,
    onSurfaceVariant = Palette.PaperMuted,
    surfaceContainerLowest = Palette.InkDeep,
    surfaceContainerLow = Palette.Ink,
    surfaceContainer = Palette.Surface,
    surfaceContainerHigh = Palette.SurfaceRaised,
    surfaceContainerHighest = Palette.SurfaceRaised,
    outline = Palette.Border,
    outlineVariant = Palette.Surface,
    error = Palette.Danger,
    onError = Palette.Ink,
    inverseSurface = Palette.Paper,
    inverseOnSurface = Palette.Ink,
)

private val LightColors = lightColorScheme(
    primary = Palette.LightSignal,
    onPrimary = Color.White,
    primaryContainer = Palette.LightSignalDim,
    onPrimaryContainer = Color.White,
    secondary = Palette.LightInkMuted,
    onSecondary = Color.White,
    secondaryContainer = Palette.LightSurfaceRaised,
    onSecondaryContainer = Palette.LightInk,
    tertiary = Palette.LightSignal,
    onTertiary = Color.White,
    background = Palette.LightGround,
    onBackground = Palette.LightInk,
    surface = Palette.LightGround,
    onSurface = Palette.LightInk,
    surfaceVariant = Palette.LightSurfaceRaised,
    onSurfaceVariant = Palette.LightInkMuted,
    surfaceContainerLowest = Color.White,
    surfaceContainerLow = Palette.LightGround,
    surfaceContainer = Palette.LightSurface,
    surfaceContainerHigh = Palette.LightSurfaceRaised,
    surfaceContainerHighest = Palette.LightSurfaceRaised,
    outline = Palette.LightBorder,
    outlineVariant = Palette.LightSurfaceRaised,
    error = Palette.Danger,
    onError = Color.White,
    inverseSurface = Palette.Ink,
    inverseOnSurface = Palette.Paper,
)

/**
 * The type scale.
 *
 * The web app pairs Unbounded with Instrument Sans. Neither is on Android and
 * bundling two variable fonts for a first build is weight for its own sake, so
 * this maps onto the system faces and leans on weight for the display voice,
 * the way the iOS client does.
 */
private val PqpTypography = Typography().let { base ->
    base.copy(
        displaySmall = base.displaySmall.copy(fontWeight = FontWeight.Black),
        headlineLarge = base.headlineLarge.copy(fontWeight = FontWeight.ExtraBold),
        headlineMedium = base.headlineMedium.copy(fontWeight = FontWeight.ExtraBold),
        headlineSmall = base.headlineSmall.copy(fontWeight = FontWeight.Bold),
        titleLarge = base.titleLarge.copy(fontWeight = FontWeight.Bold),
        titleMedium = base.titleMedium.copy(fontWeight = FontWeight.SemiBold),
        labelSmall = TextStyle(
            fontFamily = FontFamily.Default,
            fontWeight = FontWeight.SemiBold,
            fontSize = 11.sp,
            letterSpacing = 0.8.sp,
        ),
    )
}

@Composable
fun PqpTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkColors else LightColors,
        typography = PqpTypography,
        content = content,
    )
}
