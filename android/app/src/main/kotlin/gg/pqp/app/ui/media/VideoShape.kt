package gg.pqp.app.ui.media

import gg.pqp.app.core.Attachment

/**
 * How tall to draw a video attachment before anything has been downloaded.
 *
 * Its own file, with no Compose in it, because it is the one decision here that
 * is arithmetic rather than layout and it is worth being able to test on the
 * JVM without a device.
 */

/** Video with no believable stored dimensions falls back to the shape most video is. */
internal const val DEFAULT_VIDEO_ASPECT = 16f / 9f

/**
 * The window a stored ratio has to fall inside to be believed.
 *
 * `width` and `height` on an attachment row are a *client claim*: the mint
 * request carries them and the server bounds them at 20000 rather than
 * measuring the file, so an attachment can honestly say it is 20000 by 1. A
 * card drawn to that is a hairline, and one drawn to its inverse is taller than
 * the screen. Anything outside these is treated as absent rather than trusted.
 */
internal const val MIN_VIDEO_ASPECT = 0.3f
internal const val MAX_VIDEO_ASPECT = 4f

/**
 * The card's shape, from the stored dimensions when they are believable.
 *
 * They usually are not there at all: the server records width and height for
 * images it can measure, and a video row commonly carries neither, so the
 * fallback is the common case rather than the edge one.
 */
internal fun videoAspect(attachment: Attachment): Float {
    val width = attachment.width ?: return DEFAULT_VIDEO_ASPECT
    val height = attachment.height ?: return DEFAULT_VIDEO_ASPECT
    if (width <= 0 || height <= 0) return DEFAULT_VIDEO_ASPECT

    val ratio = width.toFloat() / height.toFloat()
    return if (ratio in MIN_VIDEO_ASPECT..MAX_VIDEO_ASPECT) ratio else DEFAULT_VIDEO_ASPECT
}
