package gg.pqp.app.stories.editor

import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.layout.layout
import androidx.compose.ui.unit.Constraints
import kotlin.math.roundToInt

/**
 * Puts a layer on the canvas: centred at (`x`, `y`) as fractions of it, scaled
 * and turned about its own centre. The editor and the viewer both place every
 * layer through this, so a layer is in the same place on both.
 *
 * The layer is measured at its natural size (unconstrained, so a text layer
 * wraps by its own max width), and the box it is placed in fills the canvas, so
 * its transform never changes what its neighbours measure.
 */
@Composable
fun PlacedLayer(
    x: Float,
    y: Float,
    scale: Float,
    rotation: Float,
    canvas: LayerMath.Canvas,
    modifier: Modifier = Modifier,
    alpha: Float = 1f,
    content: @Composable () -> Unit,
) {
    Box(
        modifier.layout { measurable, constraints ->
            val placeable = measurable.measure(Constraints())
            layout(constraints.maxWidth, constraints.maxHeight) {
                placeable.placeWithLayer(
                    (x * canvas.width - placeable.width / 2f).roundToInt(),
                    (y * canvas.height - placeable.height / 2f).roundToInt(),
                ) {
                    scaleX = scale
                    scaleY = scale
                    rotationZ = Math.toDegrees(rotation.toDouble()).toFloat()
                    transformOrigin = TransformOrigin.Center
                    this.alpha = alpha
                }
            }
        },
    ) { content() }
}
