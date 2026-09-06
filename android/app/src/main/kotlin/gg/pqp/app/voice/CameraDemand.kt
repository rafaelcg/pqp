package gg.pqp.app.voice

/**
 * How large a surface is drawing somebody's camera.
 *
 * The two sizes this app has, and they are far enough apart to be worth a
 * different layer: a rail tile is about a hundred density-independent pixels
 * wide and the viewer is the whole phone. See [cameraReceiveLayerFor].
 */
enum class CameraSurface {
    /** The strip of faces under the call bar. */
    Tile,

    /** The full-screen viewer, one camera at a time. */
    Fullscreen,
}

/**
 * Which remote cameras are actually being drawn right now, and how big.
 *
 * The Android twin of `client/src/lib/remote-video-delivery.ts`, and it exists
 * for the same reason: on an SFU a camera nobody is looking at is a full layer
 * arriving at a decoder that draws nothing, and in a room with twenty cameras
 * that is the whole of somebody's mobile data. A subscription is not the
 * question, delivery is: [LiveKitEngine] pauses a camera with
 * `RemoteTrackPublication.setEnabled(false)` while nothing here wants it, which
 * is one signalling frame each way rather than a renegotiation.
 *
 * ### Why it counts rather than flags
 *
 * Two surfaces can draw the same person at once, and routinely do: the
 * full-screen viewer is a `Dialog`, so the rail tile behind it stays composed
 * the whole time it is open. A boolean would be cleared by whichever of the two
 * closed first, and the failure is the one that matters most here, a camera
 * going black in front of somebody who is looking straight at it. So each
 * surface is counted, and the *largest* one still bound decides the layer.
 *
 * ### Pure on purpose
 *
 * Nothing in this module can build a LiveKit `Room` without a device, so the
 * bookkeeping is the only part of the delivery path a JVM test can reach. It is
 * therefore the part worth keeping honest: every transition an engine acts on
 * comes back as a return value here rather than being decided inside a `when`
 * on the SDK's side of the wall.
 *
 * Not thread safe on its own; [LiveKitEngine] confines it to its `peerLock`.
 */
class CameraDemand {

    private class Demand {
        var tiles = 0
        var fullscreens = 0

        /** The largest surface still drawing this camera, or null for none. */
        fun wanted(): CameraSurface? = when {
            fullscreens > 0 -> CameraSurface.Fullscreen
            tiles > 0 -> CameraSurface.Tile
            else -> null
        }

        fun idle(): Boolean = tiles <= 0 && fullscreens <= 0
    }

    private val demands = HashMap<String, Demand>()

    /**
     * A surface started drawing this peer's camera.
     *
     * True when what the SFU should be told changed, which is the only thing
     * the caller acts on: a second tile for a peer already shown full screen
     * changes nothing and must not cost a signalling frame.
     */
    fun bind(peerId: String, surface: CameraSurface): Boolean {
        val demand = demands.getOrPut(peerId) { Demand() }
        val before = demand.wanted()
        when (surface) {
            CameraSurface.Tile -> demand.tiles += 1
            CameraSurface.Fullscreen -> demand.fullscreens += 1
        }
        return demand.wanted() != before
    }

    /**
     * A surface stopped drawing this peer's camera.
     *
     * True when what the SFU should be told changed. A release for a peer this
     * has never seen, or one release more than there were binds, is absorbed:
     * a composable's `onDispose` can outlive the peer it was drawing, and a
     * count driven below zero would keep a camera paused for the rest of the
     * call.
     */
    fun release(peerId: String, surface: CameraSurface): Boolean {
        val demand = demands[peerId] ?: return false
        val before = demand.wanted()
        when (surface) {
            CameraSurface.Tile -> if (demand.tiles > 0) demand.tiles -= 1
            CameraSurface.Fullscreen -> if (demand.fullscreens > 0) demand.fullscreens -= 1
        }
        val after = demand.wanted()
        if (demand.idle()) demands.remove(peerId)
        return after != before
    }

    /** The largest surface drawing this peer's camera, or null when none is. */
    fun wantedFor(peerId: String): CameraSurface? = demands[peerId]?.wanted()

    /** The peer left, or their camera went away. True when something wanted it. */
    fun forget(peerId: String): Boolean = demands.remove(peerId) != null

    /** Every peer some surface is drawing. */
    fun peerIds(): Set<String> = demands.keys.toSet()

    fun clear() {
        demands.clear()
    }
}
