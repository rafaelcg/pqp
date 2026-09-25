package gg.pqp.app.watch

/**
 * The presenter's camera, floating over their film — where the second
 * picture sits, and which of the two the stage gives the most room.
 *
 * A port of `client/src/lib/watch-camera-pip.ts`, kept to the same four
 * choices and the same names so a person moving between the phone and the
 * browser finds the same word for the same thing. Everything here is pure:
 * a preference and two flags in, a placement out, so the whole rule is
 * exercised in `WatchCameraLayoutTest` with no `ExoPlayer`, no `Context` and
 * no DataStore.
 */

/** One of the four corners the PiP can sit in. Clockwise from top-left. */
enum class CameraPipCorner { TopLeft, TopRight, BottomLeft, BottomRight }

/** The next corner, clockwise. Four taps is where you started. */
fun nextCameraPipCorner(corner: CameraPipCorner): CameraPipCorner {
    val order = listOf(
        CameraPipCorner.TopLeft,
        CameraPipCorner.TopRight,
        CameraPipCorner.BottomRight,
        CameraPipCorner.BottomLeft,
    )
    val index = order.indexOf(corner)
    return order[(index + 1) % order.size]
}

/**
 * How the viewer wants the two pictures, mirroring `CameraLayout` on web:
 *
 *  - [Pip]: the default. The film on the stage, the webcam small in a corner.
 *  - [Side]: the two side by side, film first.
 *  - [Stream]: "hide webcam". The film alone; the camera player is torn
 *    down, unless it is also carrying the presenter's separated voice, which
 *    a hidden webcam must not silence.
 *  - [Camera]: "hide stream". The webcam alone on the stage. The film keeps
 *    playing underneath, covered rather than unmounted, because it is what
 *    carries the party's audio and switching back has to be instant.
 */
enum class WatchCameraLayout { Pip, Side, Stream, Camera }

data class CameraPipPref(
    val corner: CameraPipCorner,
    val layout: WatchCameraLayout,
) {
    companion object {
        /**
         * Bottom right, film on the stage — the same default as web, for the
         * same reason: every video call in the world puts the small picture
         * there, and it is clear of the badge row and the join-call button.
         */
        val DEFAULT = CameraPipPref(CameraPipCorner.BottomRight, WatchCameraLayout.Pip)
    }
}

/**
 * Whether the layout picker is offered at all: only for a camera that is a
 * picture. No camera playlist, and the voice-only shape (`cameraHasVideo`
 * false) has nothing to lay out — it is always drawn as the [WatchCameraLayout.Pip]
 * corner, silently, whatever the viewer last picked.
 */
fun cameraLayoutOffered(cameraSrc: String?, cameraHasVideo: Boolean): Boolean =
    cameraSrc != null && cameraHasVideo

/** The layout actually in force: the viewer's, when there is a picture to lay out. */
fun effectiveCameraLayout(pref: CameraPipPref, cameraHasVideo: Boolean): WatchCameraLayout =
    if (cameraHasVideo) pref.layout else WatchCameraLayout.Pip

/**
 * Whether the camera player belongs on screen at all right now.
 *
 * Not "hide webcam" ([WatchCameraLayout.Stream]) unless the playlist also
 * carries the presenter's voice: the player is torn down instead, so a
 * webcam nobody asked to see costs no download and no decode.
 */
fun cameraPipMounted(cameraSrc: String?, layout: WatchCameraLayout, hasVoiceAudio: Boolean): Boolean {
    if (cameraSrc == null) return false
    return layout != WatchCameraLayout.Stream || hasVoiceAudio
}

/** Where the film goes when the two pictures share the stage. */
enum class StageSlot { Full, TopHalf, BottomHalf, Hidden, CornerBehind }

/**
 * Which picture gets which slot, and how the corner is placed — the one
 * function every layout reads from, so every state is decided in one place.
 *
 * [mounted] and [hasFrame] are different questions and collapsing them is a
 * deadlock: a camera that is not composed never decodes a frame, so gating
 * composition on having one means it never gets one. Between "mounted" and
 * "has a frame" the corner draws invisibly and the film keeps the full
 * stage whatever the layout, so side-by-side or hide-stream never opens on
 * a black half or a black stage while the camera loads.
 */
data class WatchStagePlacement(
    val film: StageSlot,
    /** Null when the camera is not composed at all. */
    val camera: StageSlot?,
    /** True while the camera is composed but has not produced a frame yet. */
    val cameraLoading: Boolean,
    val corner: CameraPipCorner?,
    val cameraVoiceOnly: Boolean,
)

fun watchStagePlacement(
    mounted: Boolean,
    hasFrame: Boolean,
    pref: CameraPipPref,
    layout: WatchCameraLayout,
): WatchStagePlacement {
    val none = WatchStagePlacement(
        film = StageSlot.Full,
        camera = null,
        cameraLoading = false,
        corner = null,
        cameraVoiceOnly = false,
    )
    if (!mounted) return none
    if (layout == WatchCameraLayout.Stream) {
        // Mounted for the voice alone: drawn as the corner, muted picture.
        return none.copy(camera = StageSlot.Hidden, corner = pref.corner, cameraVoiceOnly = true)
    }
    if (!hasFrame) {
        return none.copy(camera = StageSlot.Hidden, corner = pref.corner, cameraLoading = true)
    }
    return when (layout) {
        WatchCameraLayout.Side -> WatchStagePlacement(
            film = StageSlot.TopHalf,
            camera = StageSlot.BottomHalf,
            cameraLoading = false,
            corner = null,
            cameraVoiceOnly = false,
        )
        WatchCameraLayout.Camera -> WatchStagePlacement(
            film = StageSlot.CornerBehind,
            camera = StageSlot.Full,
            cameraLoading = false,
            corner = null,
            cameraVoiceOnly = false,
        )
        else -> WatchStagePlacement(
            film = StageSlot.Full,
            camera = StageSlot.Hidden,
            cameraLoading = false,
            corner = pref.corner,
            cameraVoiceOnly = false,
        )
    }
}
