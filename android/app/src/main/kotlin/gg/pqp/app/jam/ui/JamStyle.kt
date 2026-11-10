package gg.pqp.app.jam.ui

import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import gg.pqp.app.R
import gg.pqp.app.jam.JamInstrument
import gg.pqp.app.jam.JamNeed
import gg.pqp.app.ui.theme.Palette
import gg.pqp.app.ui.theme.PqpIcons
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

/*
 * The look of jam, in the app's own tokens. Nothing here invents a visual
 * system: the grounds, borders and type come from the theme, and the lime is
 * `Palette.Signal`. The only new colours are one per instrument, from the
 * approved design (lime guitar, blue bass, orange drums, pink voice) with a
 * teal for keys and a warm grey for "other", the same six the iOS client draws.
 *
 * A tile is the instrument's colour with INK text on it, in both themes: the
 * colour is the thing being drawn, so it does not follow the page's light or
 * dark. Everything around the tiles sits on the theme's own surfaces.
 */

/** Ink for text and waveforms drawn on an instrument-coloured tile. */
val JamInk = Color(0xFF090E12)

fun JamInstrument.color(): Color = when (this) {
    JamInstrument.Guitar -> Palette.Signal
    JamInstrument.Bass -> Color(0xFF7DB8F2)
    JamInstrument.Drums -> Color(0xFFF2A34A)
    JamInstrument.Vocals -> Color(0xFFE8A3D6)
    JamInstrument.Keys -> Color(0xFF70D1CC)
    JamInstrument.Other -> Color(0xFFCCC7B3)
}

fun JamInstrument.icon(): ImageVector = when (this) {
    JamInstrument.Guitar -> PqpIcons.InstrumentGuitar
    JamInstrument.Bass -> PqpIcons.InstrumentBass
    JamInstrument.Drums -> PqpIcons.InstrumentDrums
    JamInstrument.Vocals -> PqpIcons.InstrumentVocals
    JamInstrument.Keys -> PqpIcons.InstrumentKeys
    JamInstrument.Other -> PqpIcons.InstrumentOther
}

/** "guitar", for the middle of a sentence ("falta voz"). */
@Composable
fun JamInstrument.label(): String = stringResource(
    when (this) {
        JamInstrument.Guitar -> R.string.jam_instrument_guitar
        JamInstrument.Bass -> R.string.jam_instrument_bass
        JamInstrument.Drums -> R.string.jam_instrument_drums
        JamInstrument.Vocals -> R.string.jam_instrument_vocals
        JamInstrument.Keys -> R.string.jam_instrument_keys
        JamInstrument.Other -> R.string.jam_instrument_other
    },
)

/** "Guitar", for a label that starts a line. */
@Composable
fun JamInstrument.title(): String = label().replaceFirstChar { it.uppercase() }

/** "baixo, bateria e voz": a list in the person's own language. */
fun joinList(items: List<String>, and: String): String = when (items.size) {
    0 -> ""
    1 -> items[0]
    else -> items.dropLast(1).joinToString(", ") + " $and " + items.last()
}

/** The words on a tile: "falta voz", "qualquer um entra", "pronta". */
@Composable
fun JamNeed.text(): String = when (this) {
    is JamNeed.Missing -> {
        val names = instruments.map { it.label() }
        stringResource(R.string.jam_need_missing, joinList(names, stringResource(R.string.jam_and)))
    }
    JamNeed.Open -> stringResource(R.string.jam_need_open)
    JamNeed.Ready -> stringResource(R.string.jam_need_ready)
    JamNeed.Empty -> stringResource(R.string.jam_need_empty)
}

/** Lime when somebody is wanted, so the eye finds the songs that need you; quiet otherwise. */
val JamNeed.isCallout: Boolean get() = this is JamNeed.Missing

object JamTime {
    /** 2:14, the way the design writes it. */
    fun clock(ms: Double): String {
        val total = max(0, (ms / 1000).toInt())
        return "%d:%02d".format(total / 60, total % 60)
    }
}

/**
 * Bars across a width, from 0..1 values (the server's `peaks`, resampled).
 *
 *  - [draw] is how much of the row has been drawn in (0 to 1), for the entrance;
 *  - [played] is read in the draw phase and colours the bars up to a fraction in
 *    [playedColor], so a playhead moving sixty times a second repaints bars and
 *    recomposes nothing;
 *  - the head and tail outside [dimBefore]..[dimAfter] are faded, not removed,
 *    so a trim reads as a trim and not as missing audio.
 */
@Composable
fun JamWaveform(
    values: List<Double>,
    color: Color,
    modifier: Modifier = Modifier,
    playedColor: Color? = null,
    played: () -> Float = { 0f },
    draw: () -> Float = { 1f },
    dimBefore: Float = 0f,
    dimAfter: Float = 1f,
    barWidthPx: Float = 3f,
    gapPx: Float = 2f,
    minHeightPx: Float = 3f,
) {
    Canvas(modifier) {
        val step = barWidthPx + gapPx
        val count = max(1, ((size.width + gapPx) / step).toInt())
        val source = if (values.isEmpty()) List(count) { 0.0 } else values
        val progress = draw()
        val playedFraction = played()
        for (i in 0 until count) {
            val x = i * step
            val fraction = (i + 0.5f) / count
            // Resample by taking the loudest value in this bar's span, so a short transient is not averaged away.
            val lo = (i.toFloat() / count * source.size).toInt()
            val hi = max(lo + 1, ((i + 1).toFloat() / count * source.size).toInt())
            var peak = 0.0
            for (k in lo until min(hi, source.size)) peak = max(peak, source[k])
            val eased = min(1.0, max(0.0, peak)).pow(0.7).toFloat()
            val reveal = min(1f, max(0f, progress * 1.4f - fraction * 0.4f))
            val height = max(minHeightPx, eased * size.height) * reveal
            var tint = if (playedColor != null && fraction <= playedFraction) playedColor else color
            if (fraction < dimBefore || fraction > dimAfter) tint = tint.copy(alpha = tint.alpha * 0.28f)
            drawRoundRect(
                color = tint,
                topLeft = Offset(x, (size.height - height) / 2f),
                size = Size(barWidthPx, height),
                cornerRadius = CornerRadius(barWidthPx / 2f),
            )
        }
    }
}
