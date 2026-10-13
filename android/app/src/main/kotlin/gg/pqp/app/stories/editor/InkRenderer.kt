package gg.pqp.app.stories.editor

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import gg.pqp.app.stories.StoryLayers
import java.io.ByteArrayOutputStream

/**
 * Draws ink with `android.graphics`, for both places it has to look the same:
 * the live canvas (through Compose's native canvas) and the transparent PNG
 * that is uploaded. One renderer, so the exported drawing is the one that was
 * on screen, stroke for stroke.
 *
 * The strokes are drawn into their own layer: the eraser clears the ink under
 * it (PorterDuff.CLEAR) without touching the photo behind, which is another
 * layer entirely.
 */
object InkRenderer {

    /** Draws [strokes] into [canvas], sized [width] x [height] px. Call inside a layer the eraser may clear. */
    fun draw(canvas: Canvas, strokes: List<Stroke>, width: Float, height: Float) {
        val layer = canvas.saveLayer(0f, 0f, width, height, null)
        strokes.forEach { drawStroke(canvas, it, width, height) }
        canvas.restoreToCount(layer)
    }

    private fun paintFor(stroke: Stroke, width: Float): Paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = if (stroke.brush == Brushes.HIGHLIGHTER) Paint.Cap.SQUARE else Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
        strokeWidth = stroke.width * width
        if (stroke.brush == Brushes.ERASER) {
            xfermode = PorterDuffXfermode(PorterDuff.Mode.CLEAR)
            color = 0xFF000000.toInt()
        } else {
            val argb = StoryLayers.colorArgb(stroke.color)
            val alpha = (Brushes.alpha(stroke.brush) * 255).toInt()
            color = ((argb and 0x00FFFFFF) or (alpha.toLong() shl 24)).toInt()
        }
    }

    private fun drawStroke(canvas: Canvas, stroke: Stroke, width: Float, height: Float) {
        val points = stroke.points
        if (points.size < 2) return
        val paint = paintFor(stroke, width)
        if (points.size < 4) {
            // A tap is a dot: a round stroke of no length, drawn as a circle so it shows.
            val dot = Paint(paint).apply { style = Paint.Style.FILL }
            canvas.drawCircle(points[0] * width, points[1] * height, paint.strokeWidth / 2f, dot)
            return
        }
        val path = Path()
        path.moveTo(points[0] * width, points[1] * height)
        var previousX = points[0] * width
        var previousY = points[1] * height
        var i = 2
        while (i + 1 < points.size) {
            val x = points[i] * width
            val y = points[i + 1] * height
            // Quadratic through the midpoints: the line is smooth, not a polyline of finger samples.
            path.quadTo(previousX, previousY, (previousX + x) / 2f, (previousY + y) / 2f)
            previousX = x
            previousY = y
            i += 2
        }
        path.lineTo(previousX, previousY)
        canvas.drawPath(path, paint)
    }

    /**
     * Committed ink, drawn once into a bitmap and kept: while a stroke is being
     * drawn the screen shows this plus the live stroke, instead of replaying
     * every earlier point on every frame.
     */
    class Cache {
        private var strokes: List<Stroke>? = null
        private var width = 0
        private var height = 0
        private var bitmap: Bitmap? = null

        fun bitmapFor(strokes: List<Stroke>, width: Int, height: Int): Bitmap? {
            if (strokes.isEmpty() || width <= 0 || height <= 0) return null
            if (bitmap == null || this.strokes !== strokes || this.width != width || this.height != height) {
                bitmap?.recycle()
                bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888).also {
                    draw(Canvas(it), strokes, width.toFloat(), height.toFloat())
                }
                this.strokes = strokes
                this.width = width
                this.height = height
            }
            return bitmap
        }

        fun release() {
            bitmap?.recycle()
            bitmap = null
            strokes = null
        }
    }

    /** [base] (the committed ink) with [live] on top, in one layer so an eraser takes ink off [base] too. */
    fun drawOver(canvas: Canvas, base: Bitmap?, live: Stroke?, width: Float, height: Float) {
        val layer = canvas.saveLayer(0f, 0f, width, height, null)
        base?.let { canvas.drawBitmap(it, 0f, 0f, null) }
        live?.let { drawStroke(canvas, it, width, height) }
        canvas.restoreToCount(layer)
    }

    /** The ink as a transparent PNG at the canvas aspect. */
    fun renderPng(strokes: List<Stroke>, width: Int, height: Int): ByteArray {
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        try {
            draw(Canvas(bitmap), strokes, width.toFloat(), height.toFloat())
            val out = ByteArrayOutputStream()
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
            return out.toByteArray()
        } finally {
            bitmap.recycle()
        }
    }

    /** The PNG's size: the canvas aspect at the story's long edge (810 x 1440). */
    fun exportSize(): Pair<Int, Int> {
        val height = gg.pqp.app.stories.StoriesRules.IMAGE_MAX_EDGE
        return (height * 9 / 16) to height
    }
}
