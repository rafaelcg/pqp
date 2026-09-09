package gg.pqp.app.voice

import gg.pqp.app.core.VoiceParticipant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Following a room that moved onto the voice server mid-call.
 *
 * The whole reason this logic is a pure function is that its failure mode has
 * no symptom. Declaring `voice-transport-changed` makes the server keep this
 * device's seat instead of releasing it, so every branch that wrongly declines
 * to move leaves somebody sitting in a call they cannot hear, on a roster
 * everybody else can see. Nothing on any screen says so.
 *
 * So both directions are pinned: the cases that must move, and the cases that
 * must not.
 */
class TransportChangeTest {

    private val room = "9f2b6f8a-0000-4000-8000-000000000001"
    private val me = "peer-me"

    private fun peer(id: String, sharingScreen: Boolean = false) = VoiceParticipant(
        peerId = id,
        userId = "user-$id",
        displayName = id,
        sharingScreen = sharingScreen,
    )

    private val roomOfThree = listOf(peer(me), peer("peer-a"), peer("peer-b"))

    private fun plan(
        frameChannelId: String? = room,
        frameTransport: String? = "livekit",
        reason: String? = "cameras",
        frameParticipants: List<VoiceParticipant> = roomOfThree,
        heldParticipants: List<VoiceParticipant> = roomOfThree,
        inChannelId: String? = room,
        active: Boolean = true,
        currentTransport: VoiceTransportKind = VoiceTransportKind.Mesh,
        localPeerId: String? = me,
        sharingScreen: Boolean = false,
    ) = transportChangePlan(
        frameChannelId = frameChannelId,
        frameTransport = frameTransport,
        reason = reason,
        frameParticipants = frameParticipants,
        heldParticipants = heldParticipants,
        inChannelId = inChannelId,
        active = active,
        currentTransport = currentTransport,
        localPeerId = localPeerId,
        sharingScreen = sharingScreen,
    )

    // --- the case that has to work -------------------------------------

    @Test
    fun `a promotion of the room we are in moves the media and keeps the seat`() {
        val plan = plan()
        assertTrue("A promotion of our own room must be followed", plan != null)
        assertEquals(VoiceTransportKind.LiveKit, plan!!.transport)
        assertEquals("The seat is kept, not re-minted: a promotion is not a rejoin", me, plan.peerId)
        assertEquals(roomOfThree, plan.participants)
        assertEquals(PromotionNotice.Cameras, plan.notice)
    }

    @Test
    fun `the frame's participant list is what the SFU session is built from`() {
        // The server sends the room as it holds it at the instant of the
        // promotion, self included, so the receiver does not have to wait for
        // a roster to know who is there.
        val fresh = roomOfThree + peer("peer-c")
        assertEquals(fresh, plan(frameParticipants = fresh)!!.participants)
    }

    @Test
    fun `a frame with no participants leaves the roster this device already had`() {
        // Taking an empty list verbatim would blank the call bar until the
        // next full roster, which is up to ten seconds of a call that looks
        // empty while everybody is still talking.
        assertEquals(roomOfThree, plan(frameParticipants = emptyList())!!.participants)
    }

    @Test
    fun `an outgoing screen share is stopped, because this client publishes one on mesh only`() {
        assertEquals(false, plan(sharingScreen = false)!!.stopScreenShare)
        assertEquals(true, plan(sharingScreen = true)!!.stopScreenShare)
    }

    // --- the cases that must not move ----------------------------------

    @Test
    fun `a frame about another room is ignored`() {
        assertNull(plan(frameChannelId = "9f2b6f8a-0000-4000-8000-000000000002"))
        assertNull(plan(frameChannelId = null))
    }

    @Test
    fun `a frame that arrives when we are not in a call is ignored`() {
        assertNull(plan(active = false))
    }

    @Test
    fun `a frame naming mesh is ignored, because a promotion is one-way`() {
        // Nothing demotes a live room. A frame that says so is a server this
        // build does not understand, and tearing a working call down on it
        // would be guessing.
        assertNull(plan(frameTransport = "mesh"))
        assertNull(plan(frameTransport = null))
    }

    @Test
    fun `a live SFU call is never dragged back onto a mesh`() {
        // The case above is also refused by the duplicate guard, since a mesh
        // room told to become mesh is already there. This is the one that
        // isolates the one-way rule: a room on the voice server, told to go
        // back. Following it would tear down working media and rebuild a mesh
        // in a room whose signalling the server no longer relays.
        assertNull(
            plan(
                frameTransport = "mesh",
                currentTransport = VoiceTransportKind.LiveKit,
            ),
        )
    }

    @Test
    fun `a frame naming a transport this build cannot run is ignored`() {
        assertNull(plan(frameTransport = "cloudflare-sfu"))
    }

    @Test
    fun `a duplicate promotion does not tear a live SFU session down`() {
        // Two people turning a camera on in the same second, or a cluster bus
        // replay, arrives as a second frame saying what already happened.
        assertNull(plan(currentTransport = VoiceTransportKind.LiveKit))
    }

    @Test
    fun `a promotion with no seat to keep is ignored`() {
        assertNull(plan(localPeerId = null))
    }

    // --- the sentence ---------------------------------------------------

    @Test
    fun `each promotion reason picks its sentence, and an unknown one still gets said`() {
        assertEquals(PromotionNotice.Cameras, promotionNoticeFor("cameras"))
        assertEquals(PromotionNotice.Screens, promotionNoticeFor("screens"))
        assertEquals(PromotionNotice.Room, promotionNoticeFor("room-full"))
        assertEquals(PromotionNotice.Room, promotionNoticeFor("room-size"))
        assertEquals(PromotionNotice.Room, promotionNoticeFor("stale-pin"))
        // A reason a newer server invents. "The room grew" is true of every
        // promotion, so it is the safe sentence rather than no sentence.
        assertEquals(PromotionNotice.Room, promotionNoticeFor("something-new"))
        assertEquals(PromotionNotice.Room, promotionNoticeFor(null))
    }
}
