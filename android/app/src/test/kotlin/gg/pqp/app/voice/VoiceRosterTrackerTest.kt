package gg.pqp.app.voice

import gg.pqp.app.core.VoiceParticipant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The convergence rule, tested from the outside.
 *
 * A roster bug on a phone does not look like an error. It looks like somebody
 * missing from a call, or a moderator's mute that never lands, and it looks
 * exactly the same as the other person having a bad connection. So the cases
 * below are written as the three ways this can be wrong rather than as a walk
 * through the happy path: a peer silently dropped, an update silently missed,
 * and a gap silently applied.
 */
class VoiceRosterTrackerTest {

    private fun peer(
        id: String,
        name: String = id,
        muted: Boolean = false,
        serverMuted: Boolean = false,
        sharingScreen: Boolean = false,
        cameraStreamId: String? = null,
        canSpeak: Boolean = true,
    ) = VoiceParticipant(
        peerId = id,
        userId = "user-$id",
        displayName = name,
        avatarUrl = null,
        sharingScreen = sharingScreen,
        cameraStreamId = cameraStreamId,
        screenAudioStreamId = null,
        muted = muted,
        deafened = false,
        serverMuted = serverMuted,
        canSpeak = canSpeak,
    )

    private fun ids(participants: List<VoiceParticipant>?) = participants?.map { it.peerId }

    // --- the ordinary case ---------------------------------------------------

    @Test
    fun `a delta after a snapshot adds updates and removes in one frame`() {
        val tracker = VoiceRosterTracker()
        tracker.snapshot("c1", listOf(peer("a"), peer("b"), peer("c")), seq = 7)

        val room = tracker.delta(
            channelId = "c1",
            seq = 8,
            size = 3,
            joined = listOf(peer("d")),
            updated = listOf(peer("b", muted = true)),
            left = listOf("a"),
        )

        assertEquals(listOf("b", "c", "d"), ids(room))
        assertEquals(true, room?.first { it.peerId == "b" }?.muted)
        assertEquals(8, tracker.sequence)
    }

    @Test
    fun `several deltas in a row compose`() {
        val tracker = VoiceRosterTracker()
        tracker.snapshot("c1", listOf(peer("a")), seq = 1)

        tracker.delta("c1", seq = 2, size = 2, joined = listOf(peer("b")))
        tracker.delta("c1", seq = 3, size = 3, joined = listOf(peer("c")))
        val room = tracker.delta("c1", seq = 4, size = 2, left = listOf("a"))

        assertEquals(listOf("b", "c"), ids(room))
    }

    /**
     * The one that would show as faces jumping around the call screen every
     * time anybody muted. A replaced peer keeps its place; a new one goes on
     * the end. Same as the `Map` the web client patches.
     */
    @Test
    fun `an update keeps the peer where it was and a join goes on the end`() {
        val tracker = VoiceRosterTracker()
        tracker.snapshot("c1", listOf(peer("a"), peer("b"), peer("c")), seq = 1)

        val room = tracker.delta(
            channelId = "c1",
            seq = 2,
            size = 4,
            joined = listOf(peer("d")),
            updated = listOf(peer("a", muted = true)),
        )

        assertEquals(listOf("a", "b", "c", "d"), ids(room))
    }

    /**
     * Every entry is an absolute statement about one peer, which is the
     * property that makes a delta overlapping a snapshot harmless. If it were
     * relative, this would double-count.
     */
    @Test
    fun `re-stating a peer the snapshot already carried changes nothing`() {
        val tracker = VoiceRosterTracker()
        tracker.snapshot("c1", listOf(peer("a"), peer("b")), seq = 4)

        val room = tracker.delta("c1", seq = 5, size = 2, joined = listOf(peer("b")))

        assertEquals(listOf("a", "b"), ids(room))
    }

    // --- the three ways it can be wrong --------------------------------------

    /**
     * A GAP MUST NOT BE APPLIED. Frame 9 never arrived, so frame 10 is
     * measured against a room that is missing whatever 9 said. Applying it
     * would leave a peer permanently wrong with nothing to notice it.
     */
    @Test
    fun `a delta that skips a sequence is refused and changes nothing`() {
        val tracker = VoiceRosterTracker()
        tracker.snapshot("c1", listOf(peer("a"), peer("b")), seq = 8)

        assertNull(tracker.delta("c1", seq = 10, size = 3, joined = listOf(peer("d"))))
        assertEquals(8, tracker.sequence)

        // And the refusal does not advance the sequence: the next frame in
        // line is still 9, not 11. A tracker that had crept forward would
        // start accepting deltas again on top of a baseline missing a peer.
        val room = tracker.delta("c1", seq = 9, size = 3, joined = listOf(peer("c")))
        assertEquals(listOf("a", "b", "c"), ids(room))
    }

    /** A frame delivered twice, or out of order behind a newer one. */
    @Test
    fun `a delta with a sequence already applied is refused`() {
        val tracker = VoiceRosterTracker()
        tracker.snapshot("c1", listOf(peer("a")), seq = 3)
        tracker.delta("c1", seq = 4, size = 2, joined = listOf(peer("b")))

        assertNull(tracker.delta("c1", seq = 4, size = 2, joined = listOf(peer("b"))))
        assertEquals(4, tracker.sequence)
    }

    /**
     * THE SECOND, INDEPENDENT CHECK. The sequence is perfect and the room
     * still does not match, which is divergence `seq` cannot see. Stop
     * patching and wait for the keyframe rather than draw a room nobody else
     * is in.
     */
    @Test
    fun `a delta whose size disagrees is refused and changes nothing`() {
        val tracker = VoiceRosterTracker()
        tracker.snapshot("c1", listOf(peer("a"), peer("b")), seq = 2)

        assertNull(tracker.delta("c1", seq = 3, size = 9, joined = listOf(peer("c"))))
        assertEquals(2, tracker.sequence)

        // Nothing was written: the refused join is not sitting in the baseline
        // waiting to make the next size check fail too.
        val room = tracker.delta("c1", seq = 3, size = 3, joined = listOf(peer("c")))
        assertEquals(listOf("a", "b", "c"), ids(room))
    }

    /**
     * The repair. Whatever went wrong, and whether or not this client could
     * tell, the next full roster replaces the state wholesale.
     */
    @Test
    fun `a keyframe repairs a client that had given up on the deltas`() {
        val tracker = VoiceRosterTracker()
        tracker.snapshot("c1", listOf(peer("a")), seq = 5)
        assertNull(tracker.delta("c1", seq = 40, size = 2, joined = listOf(peer("b"))))

        val repaired = tracker.snapshot("c1", listOf(peer("b"), peer("c")), seq = 41)
        assertEquals(listOf("b", "c"), ids(repaired))

        val room = tracker.delta("c1", seq = 42, size = 3, joined = listOf(peer("d")))
        assertEquals(listOf("b", "c", "d"), ids(room))
    }

    // --- baselines, empty rooms, and other rooms ------------------------------

    /**
     * A client with no baseline holds 0, so the first delta of a room that has
     * been empty is self-sufficient. Without this, joining an empty channel
     * and watching one person arrive would show nothing for up to ten seconds.
     */
    @Test
    fun `the first delta of a fresh room applies with no baseline at all`() {
        val tracker = VoiceRosterTracker()

        val room = tracker.delta("c1", seq = 1, size = 1, joined = listOf(peer("a")))

        assertEquals(listOf("a"), ids(room))
        assertEquals(1, tracker.sequence)
    }

    @Test
    fun `a delta for a room with no baseline that is not the first is refused`() {
        val tracker = VoiceRosterTracker()

        assertNull(tracker.delta("c1", seq = 12, size = 1, joined = listOf(peer("a"))))
        assertEquals(0, tracker.sequence)
    }

    /**
     * The server forgets an empty room's sequence so the next call in the
     * channel starts again at 1. A client that kept the old number would read
     * that first delta as a gap and sit out the whole of the next call.
     */
    @Test
    fun `emptying the room resets the sequence so the next call starts at one`() {
        val tracker = VoiceRosterTracker()
        tracker.snapshot("c1", listOf(peer("a")), seq = 6)

        val empty = tracker.delta("c1", seq = 7, size = 0, left = listOf("a"))
        assertEquals(emptyList<String>(), ids(empty))
        assertEquals(0, tracker.sequence)

        val room = tracker.delta("c1", seq = 1, size = 1, joined = listOf(peer("b")))
        assertEquals(listOf("b"), ids(room))
    }

    @Test
    fun `an empty snapshot resets the sequence too`() {
        val tracker = VoiceRosterTracker()
        tracker.snapshot("c1", listOf(peer("a")), seq = 6)
        tracker.snapshot("c1", emptyList(), seq = 7)

        assertEquals(0, tracker.sequence)
        assertEquals(listOf("b"), ids(tracker.delta("c1", seq = 1, size = 1, joined = listOf(peer("b")))))
    }

    /**
     * Walking from one voice channel into another. The sequences are per room
     * and mean nothing to each other, so a number that happens to line up must
     * not patch the wrong room's participants.
     */
    @Test
    fun `a delta for a different channel does not patch the room being tracked`() {
        val tracker = VoiceRosterTracker()
        tracker.snapshot("c1", listOf(peer("a"), peer("b")), seq = 4)

        // Sequence 5 would be the next one for c1. For c2 there is no baseline
        // at all, so only a 1 is acceptable, and this is not one.
        assertNull(tracker.delta("c2", seq = 5, size = 3, joined = listOf(peer("z"))))
        assertEquals("c1", tracker.channelId)
        assertEquals(4, tracker.sequence)

        // c1 is untouched and still following on from 4.
        assertEquals(
            listOf("a", "b", "c"),
            ids(tracker.delta("c1", seq = 5, size = 3, joined = listOf(peer("c")))),
        )
    }

    @Test
    fun `forget drops the baseline so a rebuilt call takes the next frame it is offered`() {
        val tracker = VoiceRosterTracker()
        tracker.snapshot("c1", listOf(peer("a"), peer("b")), seq = 30)

        tracker.forget()

        assertEquals(0, tracker.sequence)
        assertNull(tracker.channelId)
        // A server process that restarted numbers from 1 again, and this
        // client takes it rather than refusing the whole of the rebuilt call.
        assertEquals(
            listOf("z"),
            ids(tracker.delta("c1", seq = 1, size = 1, joined = listOf(peer("z")))),
        )
    }

    // --- what the rest of the app reads off the roster ------------------------

    /**
     * Everything [VoiceController.absorbRoster] derives has to survive the
     * delta path, because on a mesh room the roster is the *only* channel the
     * server has: a moderator's mute is enforced by every client obeying the
     * flag, and there is no second frame that carries it.
     */
    @Test
    fun `a moderator mute arriving as an update reaches the peer it names`() {
        val tracker = VoiceRosterTracker()
        tracker.snapshot("c1", listOf(peer("a"), peer("b")), seq = 1)

        val room = tracker.delta(
            channelId = "c1",
            seq = 2,
            size = 2,
            updated = listOf(peer("b", muted = true, serverMuted = true)),
        )

        val b = room?.first { it.peerId == "b" }
        assertEquals(true, b?.serverMuted)
        assertEquals(true, b?.muted)
        assertEquals(false, room?.first { it.peerId == "a" }?.serverMuted)
    }

    @Test
    fun `a screen share and a camera stream id survive the delta path`() {
        val tracker = VoiceRosterTracker()
        tracker.snapshot("c1", listOf(peer("a")), seq = 1)

        val sharing = tracker.delta(
            channelId = "c1",
            seq = 2,
            size = 1,
            updated = listOf(peer("a", sharingScreen = true, cameraStreamId = "cam-1")),
        )
        assertEquals(true, sharing?.single()?.sharingScreen)
        assertEquals("cam-1", sharing?.single()?.cameraStreamId)

        // And the end of a share, which is the one thing only the roster can
        // say: the screen is defined negatively and announces no id to null.
        val stopped = tracker.delta(
            channelId = "c1",
            seq = 3,
            size = 1,
            updated = listOf(peer("a", sharingScreen = false, cameraStreamId = null)),
        )
        assertEquals(false, stopped?.single()?.sharingScreen)
        assertNull(stopped?.single()?.cameraStreamId)
    }

    @Test
    fun `a SPEAK revoke arriving as an update reaches the peer it names`() {
        val tracker = VoiceRosterTracker()
        tracker.snapshot("c1", listOf(peer("a"), peer("b")), seq = 1)

        val room = tracker.delta(
            channelId = "c1",
            seq = 2,
            size = 2,
            updated = listOf(peer("b", canSpeak = false)),
        )

        assertEquals(false, room?.first { it.peerId == "b" }?.canSpeak)
        assertEquals(true, room?.first { it.peerId == "a" }?.canSpeak)
    }

    /**
     * A busy window: several people arrive, one leaves and one mutes, all in
     * one frame. The lists are applied in order, so a peer that both joins and
     * leaves inside the same window ends up out, which is what the server saw.
     */
    @Test
    fun `a window that both adds and removes the same peer ends with it gone`() {
        val tracker = VoiceRosterTracker()
        tracker.snapshot("c1", listOf(peer("a")), seq = 1)

        val room = tracker.delta(
            channelId = "c1",
            seq = 2,
            size = 2,
            joined = listOf(peer("b"), peer("c")),
            updated = listOf(peer("a", muted = true)),
            left = listOf("c"),
        )

        assertEquals(listOf("a", "b"), ids(room))
    }

    /**
     * Self is on the roster like anybody else, and `size` counts them. A
     * tracker that quietly dropped its own entry would fail every size check
     * from the second frame on and the phone would never apply a delta again.
     */
    @Test
    fun `self stays on the roster and is counted by size`() {
        val tracker = VoiceRosterTracker()
        tracker.snapshot("c1", listOf(peer("me"), peer("a")), seq = 2)

        val room = tracker.delta("c1", seq = 3, size = 3, joined = listOf(peer("b")))

        assertEquals(listOf("me", "a", "b"), ids(room))
    }

    /** The room the 2026-09-05 incident was actually about. */
    @Test
    fun `a hundred and thirty people converge through deltas alone`() {
        val tracker = VoiceRosterTracker()
        val crowd = (1..130).map { peer("p$it") }
        tracker.snapshot("c1", crowd, seq = 100)

        var seq = 100
        var size = 130
        repeat(30) { index ->
            seq += 1
            size += 1
            tracker.delta("c1", seq = seq, size = size, joined = listOf(peer("late$index")))
        }
        repeat(10) { index ->
            seq += 1
            size -= 1
            tracker.delta("c1", seq = seq, size = size, left = listOf("p${index + 1}"))
        }
        val room = tracker.delta(
            channelId = "c1",
            seq = seq + 1,
            size = size,
            updated = listOf(peer("p50", muted = true)),
        )

        assertEquals(150, room?.size)
        assertEquals(true, room?.first { it.peerId == "p50" }?.muted)
        // The ten who left are gone, and nobody else went with them.
        assertNull(room?.firstOrNull { it.peerId == "p1" })
        assertEquals(true, room?.any { it.peerId == "p11" })
        assertEquals(true, room?.any { it.peerId == "late29" })
    }
}
