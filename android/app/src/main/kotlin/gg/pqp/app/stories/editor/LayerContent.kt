package gg.pqp.app.stories.editor

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.Canvas
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.Shadow
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import gg.pqp.app.stories.StoryLayers
import gg.pqp.app.ui.components.Avatar
import gg.pqp.app.ui.theme.Gabarito
import gg.pqp.app.ui.theme.InstrumentSans
import gg.pqp.app.ui.theme.Palette
import gg.pqp.app.ui.theme.PqpIcons

/*
 * What each kind of layer looks like. One drawing for the editor and the
 * viewer: every size is a share of the canvas width (`canvasWidthPx`), never
 * a dp, so a story reads the same on a small phone, a large one, and in the
 * editor's own canvas.
 */

@Composable
private fun pxToDp(px: Float): Dp = with(LocalDensity.current) { px.toDp() }

@Composable
private fun pxToSp(px: Float): TextUnit = with(LocalDensity.current) { px.toSp() }

/** The five fonts as the app has them: tokens the server stores, faces each platform maps itself. */
fun storyFont(font: String): Pair<FontFamily, FontWeight> = when (font) {
    "bold" -> Gabarito to FontWeight.Black
    "typewriter" -> FontFamily.Monospace to FontWeight.SemiBold
    "serif" -> FontFamily.Serif to FontWeight.Bold
    "neon" -> Gabarito to FontWeight.ExtraBold
    else -> InstrumentSans to FontWeight.Bold
}

fun tokenColor(token: String): Color = Color(StoryLayers.colorArgb(token))

/** What a text layer's own colors are, given its token and background mode. */
data class TextPaintSpec(val text: Color, val box: Color?, val glow: Color?)

fun textPaint(color: String, background: String, font: String): TextPaintSpec {
    val token = tokenColor(color)
    return when {
        background == "solid" -> TextPaintSpec(
            text = if (StoryLayers.isLight(color)) Color.Black else Color.White,
            box = token,
            glow = null,
        )
        background == "soft" -> TextPaintSpec(text = token, box = Color.Black.copy(alpha = 0.45f), glow = null)
        font == "neon" -> TextPaintSpec(text = lerp(token, Color.White, 0.55f), box = null, glow = token)
        else -> TextPaintSpec(text = token, box = null, glow = null)
    }
}

/** A text layer's drawing, split so the editor's own text field can wear exactly the same clothes. */
class TextLook(val style: TextStyle, val boxModifier: Modifier, val maxWidth: Dp)

@Composable
fun rememberTextLook(
    font: String,
    color: String,
    background: String,
    align: String,
    size: Float,
    canvasWidthPx: Float,
): TextLook {
    val fontPx = LayerMath.textSizePx(size, canvasWidthPx)
    val (family, weight) = storyFont(font)
    val paint = textPaint(color, background, font)
    val shadow = when {
        paint.glow != null -> Shadow(paint.glow, Offset.Zero, fontPx * 0.45f)
        paint.box == null && StoryLayers.isLight(color) -> Shadow(Color.Black.copy(alpha = 0.4f), Offset(0f, fontPx * 0.04f), fontPx * 0.12f)
        else -> null
    }
    val box = if (paint.box != null) {
        Modifier
            .clip(RoundedCornerShape(pxToDp(fontPx * 0.32f)))
            .background(paint.box)
            .padding(horizontal = pxToDp(fontPx * 0.5f), vertical = pxToDp(fontPx * 0.2f))
    } else {
        Modifier
    }
    return TextLook(
        style = TextStyle(
            color = paint.text,
            fontFamily = family,
            fontWeight = weight,
            fontSize = pxToSp(fontPx),
            lineHeight = pxToSp(fontPx * StoryLayers.TEXT_LINE_HEIGHT),
            // The serif face is italic, as web draws it.
            fontStyle = if (font == "serif") androidx.compose.ui.text.font.FontStyle.Italic else null,
            textAlign = when (align) {
                "left" -> TextAlign.Start
                "right" -> TextAlign.End
                else -> TextAlign.Center
            },
            shadow = shadow,
        ),
        boxModifier = box,
        maxWidth = pxToDp(StoryLayers.TEXT_WRAP_WIDTH * canvasWidthPx),
    )
}

@Composable
fun TextLayerContent(
    text: String,
    font: String,
    color: String,
    background: String,
    align: String,
    size: Float,
    canvasWidthPx: Float,
    modifier: Modifier = Modifier,
) {
    val look = rememberTextLook(font, color, background, align, size, canvasWidthPx)
    Box(modifier.then(look.boxModifier)) {
        Text(text = text, style = look.style, modifier = Modifier.widthIn(max = look.maxWidth))
    }
}

/** A photo layer's box: the picture's own shape, or a square when it is cropped to a circle. */
fun photoBox(shape: String, width: Int, height: Int, canvasWidthPx: Float): LayerMath.Size {
    val natural = LayerMath.photoSize(width, height, canvasWidthPx)
    return if (shape == "circle") LayerMath.Size(natural.width, natural.width) else natural
}

@Composable
fun PhotoLayerContent(
    model: Any?,
    shape: String,
    width: Int,
    height: Int,
    canvasWidthPx: Float,
    description: String?,
    modifier: Modifier = Modifier,
) {
    val box = photoBox(shape, width, height, canvasWidthPx)
    val clip: Shape = when (shape) {
        "circle" -> CircleShape
        "rounded" -> RoundedCornerShape(pxToDp(box.width * 0.1f))
        else -> RoundedCornerShape(0.dp)
    }
    var failed by remember(model) { mutableStateOf(false) }
    Box(
        modifier
            .size(pxToDp(box.width), pxToDp(box.height))
            .clip(clip)
            .border(pxToDp(canvasWidthPx * 0.008f), Color.White, clip),
        contentAlignment = Alignment.Center,
    ) {
        AsyncImage(
            model = model,
            contentDescription = description,
            contentScale = ContentScale.Crop,
            onError = { failed = true },
            onSuccess = { failed = false },
            modifier = Modifier.fillMaxSize(),
        )
        // A photo that would not load is a grey card with a picture on it, never an empty layer
        // that looks fine and posts blank: it can still be moved, shaped and deleted.
        if (failed) {
            Box(Modifier.fillMaxSize().background(Color(0xFF2A2F36)), contentAlignment = Alignment.Center) {
                Icon(PqpIcons.Image, contentDescription = null, tint = Color.White.copy(alpha = 0.6f), modifier = Modifier.size(pxToDp(box.width * 0.25f)))
            }
        }
    }
}

@Composable
fun MentionLayerContent(name: String, canvasWidthPx: Float, modifier: Modifier = Modifier) {
    val unit = canvasWidthPx
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = modifier
            .clip(RoundedCornerShape(50))
            .background(Color.White.copy(alpha = 0.95f))
            .padding(horizontal = pxToDp(unit * 0.035f), vertical = pxToDp(unit * 0.018f)),
    ) {
        Icon(PqpIcons.Handle, contentDescription = null, tint = Palette.Ink, modifier = Modifier.size(pxToDp(unit * 0.05f)))
        Box(Modifier.size(pxToDp(unit * 0.008f)))
        Text(
            name,
            color = Palette.Ink,
            fontFamily = Gabarito,
            fontWeight = FontWeight.ExtraBold,
            fontSize = pxToSp(unit * StoryLayers.MENTION_FONT),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.widthIn(max = pxToDp(unit * 0.6f)),
        )
    }
}

/** A person in the call right now, for the faces on the call card. */
data class CallFace(val id: String, val name: String, val avatarUrl: String?)

/**
 * The "chama pra call" card as the editor draws it: the room, the server, who
 * is in it right now, and the join button the viewer will have. The story
 * viewer draws the live version of the same card from the same measures.
 */
@Composable
fun CallLayerContent(
    roomName: String,
    serverName: String,
    faces: List<CallFace>,
    callLabel: String,
    joinLabel: String,
    canvasWidthPx: Float,
    modifier: Modifier = Modifier,
) {
    val unit = canvasWidthPx
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = modifier
            .widthIn(max = pxToDp(unit * 0.84f))
            .clip(RoundedCornerShape(pxToDp(unit * 0.05f)))
            .background(Color.Black.copy(alpha = 0.62f))
            .border(pxToDp(unit * 0.004f), Palette.Signal.copy(alpha = 0.7f), RoundedCornerShape(pxToDp(unit * 0.05f)))
            .padding(pxToDp(unit * 0.03f)),
    ) {
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier.size(pxToDp(unit * 0.1f)).clip(CircleShape).background(Palette.Signal),
        ) {
            Icon(PqpIcons.Listening, contentDescription = null, tint = Palette.Ink, modifier = Modifier.size(pxToDp(unit * 0.055f)))
        }
        Column(Modifier.padding(horizontal = pxToDp(unit * 0.025f)).widthIn(max = pxToDp(unit * 0.4f))) {
            Text(
                callLabel,
                color = Palette.Signal,
                fontSize = pxToSp(unit * 0.03f),
                fontFamily = InstrumentSans,
                fontWeight = FontWeight.Bold,
                maxLines = 1,
            )
            Text(
                roomName,
                color = Color.White,
                fontFamily = Gabarito,
                fontWeight = FontWeight.ExtraBold,
                fontSize = pxToSp(unit * 0.048f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (serverName.isNotBlank()) {
                Text(
                    serverName,
                    color = Color.White.copy(alpha = 0.7f),
                    fontSize = pxToSp(unit * 0.03f),
                    fontFamily = InstrumentSans,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (faces.isNotEmpty()) {
            Row(horizontalArrangement = Arrangement.spacedBy(pxToDp(-unit * 0.012f))) {
                faces.take(3).forEach {
                    Avatar(name = it.name, url = it.avatarUrl, seed = it.id, size = pxToDp(unit * 0.07f))
                }
            }
        }
        Box(
            Modifier
                .padding(start = pxToDp(unit * 0.02f))
                .clip(RoundedCornerShape(50))
                .background(Palette.Signal)
                .padding(horizontal = pxToDp(unit * 0.03f), vertical = pxToDp(unit * 0.015f)),
        ) {
            Text(
                joinLabel,
                color = Palette.Ink,
                fontFamily = Gabarito,
                fontWeight = FontWeight.ExtraBold,
                fontSize = pxToSp(unit * 0.036f),
                maxLines = 1,
            )
        }
    }
}

/**
 * The ink over the picture, drawn by the same renderer that exports it. The
 * committed strokes are rasterised once (they only change when a stroke is
 * added or undone); [live] is the stroke under the finger, drawn over them.
 */
@Composable
fun InkLayerContent(strokes: List<Stroke>, modifier: Modifier = Modifier, live: Stroke? = null) {
    val cache = remember { InkRenderer.Cache() }
    DisposableEffect(cache) { onDispose { cache.release() } }
    Canvas(modifier.fillMaxSize().graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }) {
        val base = cache.bitmapFor(strokes, size.width.toInt(), size.height.toInt())
        drawIntoCanvas { InkRenderer.drawOver(it.nativeCanvas, base, live, size.width, size.height) }
    }
}
