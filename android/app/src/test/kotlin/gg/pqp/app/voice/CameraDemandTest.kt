package gg.pqp.app.voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Which cameras the SFU should actually be sending, and how big.
 *
 * Every test here is written from the failure it prevents, and they are all the
 * same shape of failure in two directions: a camera flowing that nobody can
 * see, which is somebody's mobile data, or a camera paused that somebody *is*
 * looking at, which is a black rectangle where a person's face was. The second
 * is the worse one and most of this file is about it.
 *
 * The engine cannot be tested on this machine (nothing here can build a LiveKit
 * `Room` without a device), so this is the whole of the delivery decision that
 * a JVM can reach, and it is deliberately where the decision lives.
 */
class CameraDemandTest {

    @Test
    fun `nobody is drawing anything to start with`() {
        assertNull(CameraDemand().wantedFor("alice"))
    }

    @Test
    fun `a tile binding starts delivery`() {
        val demand = CameraDemand()
        assertTrue(demand.bind("alice", CameraSurface.Tile))
        assertEquals(CameraSurface.Tile, demand.wantedFor("alice"))
    }

    @Test
    fun `releasing the only tile stops it`() {
        val demand = CameraDemand()
        demand.bind("alice", CameraSurface.Tile)
        assertTrue(demand.release("alice", CameraSurface.Tile))
        assertNull(demand.wantedFor("alice"))
    }

    /**
     * The regression this class exists for.
     *
     * The full-screen viewer is a `Dialog`, so the rail tile behind it is still
     * composed and still bound the whole time it is open. With a boolean, the
     * viewer's close would pause a camera that is still on screen in the strip:
     * a face that goes black when you come back from looking at it closely, and
     * stays black.
     */
    @Test
    fun `closing the viewer leaves the tile behind it flowing`() {
        val demand = CameraDemand()
        demand.bind("alice", CameraSurface.Tile)
        assertTrue(
            "opening the viewer raises the layer",
            demand.bind("alice", CameraSurface.Fullscreen),
        )
        assertEquals(CameraSurface.Fullscreen, demand.wantedFor("alice"))
        assertTrue(demand.release("alice", CameraSurface.Fullscreen))
        assertEquals(
            "the tile is still on screen; the camera must still be arriving",
            CameraSurface.Tile,
            demand.wantedFor("alice"),
        )
    }

    /** The other order: the tile is scrolled away while the viewer is open. */
    @Test
    fun `losing the tile under an open viewer changes nothing`() {
        val demand = CameraDemand()
        demand.bind("alice", CameraSurface.Tile)
        demand.bind("alice", CameraSurface.Fullscreen)
        assertFalse(
            "the viewer is still drawing it, so the SFU is told nothing",
            demand.release("alice", CameraSurface.Tile),
        )
        assertEquals(CameraSurface.Fullscreen, demand.wantedFor("alice"))
    }

    /**
     * A recomposition can bind a second tile for the same person before the
     * first one's dispose runs. That is not a layer change and must not cost a
     * signalling frame, and, more importantly, the *first* dispose afterwards
     * must not pause a camera the second tile is drawing.
     */
    @Test
    fun `two tiles for one peer are one delivery`() {
        val demand = CameraDemand()
        assertTrue(demand.bind("alice", CameraSurface.Tile))
        assertFalse(demand.bind("alice", CameraSurface.Tile))
        assertFalse(demand.release("alice", CameraSurface.Tile))
        assertEquals(CameraSurface.Tile, demand.wantedFor("alice"))
        assertTrue(demand.release("alice", CameraSurface.Tile))
        assertNull(demand.wantedFor("alice"))
    }

    @Test
    fun `people are independent of each other`() {
        val demand = CameraDemand()
        demand.bind("alice", CameraSurface.Tile)
        demand.bind("bob", CameraSurface.Fullscreen)
        assertEquals(setOf("alice", "bob"), demand.peerIds())
        demand.release("alice", CameraSurface.Tile)
        assertNull(demand.wantedFor("alice"))
        assertEquals(CameraSurface.Fullscreen, demand.wantedFor("bob"))
    }

    /**
     * A composable's `onDispose` can arrive after the peer has already been
     * forgotten, and a naive counter would go negative and hold the camera
     * paused for the rest of the call if that person came back.
     */
    @Test
    fun `an extra release is absorbed`() {
        val demand = CameraDemand()
        demand.bind("alice", CameraSurface.Tile)
        demand.release("alice", CameraSurface.Tile)
        assertFalse(demand.release("alice", CameraSurface.Tile))
        assertFalse(demand.release("carol", CameraSurface.Fullscreen))
        assertTrue(
            "the next bind must still start delivery",
            demand.bind("alice", CameraSurface.Tile),
        )
        assertEquals(CameraSurface.Tile, demand.wantedFor("alice"))
    }

    @Test
    fun `a peer who left is forgotten and can come back`() {
        val demand = CameraDemand()
        demand.bind("alice", CameraSurface.Tile)
        assertTrue(demand.forget("alice"))
        assertNull(demand.wantedFor("alice"))
        assertFalse(demand.forget("alice"))
        assertTrue(demand.bind("alice", CameraSurface.Tile))
    }

    @Test
    fun `clearing the call drops every claim`() {
        val demand = CameraDemand()
        demand.bind("alice", CameraSurface.Tile)
        demand.bind("bob", CameraSurface.Tile)
        demand.clear()
        assertTrue(demand.peerIds().isEmpty())
        assertNull(demand.wantedFor("alice"))
    }

    /**
     * Nobody drawing a camera is the resting state, so a room full of people on
     * camera that this phone has not scrolled to costs nothing. Written as the
     * whole set rather than one peer, because the thing worth pinning is that
     * demand is *opt in*.
     */
    @Test
    fun `a camera nothing has bound is wanted by nobody`() {
        val demand = CameraDemand()
        listOf("alice", "bob", "carol").forEach { assertNull(demand.wantedFor(it)) }
        assertTrue(demand.peerIds().isEmpty())
    }
}
