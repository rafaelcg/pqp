package gg.pqp.app.stories.editor

import android.net.Uri
import android.os.Build
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.blur
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.background
import coil3.compose.AsyncImage
import gg.pqp.app.stories.ui.StoryVideoSurface
import kotlin.math.abs

/**
 * How a story's base fills the 9:16 canvas, shared by the editor and the viewer
 * so a photo sits in the same place on both.
 *
 * A picture or clip close to 9:16 (within 12%) fills the canvas, cropped a
 * hair. Anything else (a landscape photo, a square clip) is shown whole, and
 * a photo gets its own blurred, cropped copy behind it so the bars are not
 * black; a video has black bars, because blurring a playing clip twice is
 * more than a phone should do.
 */
object BaseFit {
    private const val CANVAS_ASPECT = 9f / 16f
    private const val TOLERANCE = 0.12f

    fun fills(width: Int, height: Int): Boolean {
        if (width <= 0 || height <= 0) return true
        val aspect = width.toFloat() / height
        return abs(aspect - CANVAS_ASPECT) / CANVAS_ASPECT <= TOLERANCE
    }
}

/** A photo base: filled when it is near 9:16, else shown whole over a blurred copy of itself. */
@Composable
fun StoryBaseImage(
    model: Any?,
    width: Int,
    height: Int,
    modifier: Modifier = Modifier,
    description: String? = null,
    onFirstFrame: (() -> Unit)? = null,
    /** The picture could not be loaded: nothing will be drawn, and whoever waits for a first frame should stop. */
    onFailed: (() -> Unit)? = null,
) {
    Box(modifier.fillMaxSize().background(Color.Black)) {
        if (BaseFit.fills(width, height)) {
            AsyncImage(
                model = model,
                contentDescription = description,
                contentScale = ContentScale.Crop,
                onSuccess = onFirstFrame?.let { cb -> { _ -> cb() } },
                onError = onFailed?.let { cb -> { _ -> cb() } },
                modifier = Modifier.fillMaxSize(),
            )
        } else {
            // Under the picture: the same picture, cropped to fill and blurred. Below Android 12
            // there is no blur modifier, so it is dimmed instead of left sharp and distracting.
            AsyncImage(
                model = model,
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier
                    .fillMaxSize()
                    .then(if (Build.VERSION.SDK_INT >= 31) Modifier.blur(36.dp) else Modifier.alpha(0.35f)),
            )
            AsyncImage(
                model = model,
                contentDescription = description,
                contentScale = ContentScale.Fit,
                onSuccess = onFirstFrame?.let { cb -> { _ -> cb() } },
                onError = onFailed?.let { cb -> { _ -> cb() } },
                modifier = Modifier.fillMaxSize(),
            )
        }
    }
}

/** A video base: filled when near 9:16, else whole on black. */
@Composable
fun StoryBaseVideo(uri: Uri, width: Int, height: Int, muted: Boolean, modifier: Modifier = Modifier) {
    Box(modifier.fillMaxSize().background(Color.Black)) {
        StoryVideoSurface(uri = uri, muted = muted, fill = BaseFit.fills(width, height), modifier = Modifier.fillMaxSize())
    }
}
