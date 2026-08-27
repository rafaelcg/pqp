package gg.pqp.app.voice

import java.math.BigInteger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.webrtc.RTCStats
import org.webrtc.RTCStatsReport

/**
 * The parsing that decides whether the app believes a call is carrying audio.
 *
 * The dangerous failure here is not a crash. It is a rename or a type change
 * upstream turning every reading into a confident zero, which would either
 * label a healthy call "cannot reach everyone" or, worse, be quietly dropped
 * and take the only evidence of a silent call with it.
 */
class VoiceStatsTest {

    @Test
    fun `unsigned counters arrive as BigInteger and are still read`() {
        // This is how libwebrtc's bridge hands over uint64. Reading it with a
        // `as? Long` cast returns null, and a working call reports as silent.
        val report = reportOf(
            stat(
                "inbound-rtp",
                "in-1",
                "kind" to "audio",
                "bytesReceived" to BigInteger.valueOf(15_183),
                "packetsReceived" to BigInteger.valueOf(379),
            ),
        )
        val stats = parseMediaStats(report)
        assertEquals(15_183, stats.audioBytesReceived)
        assertEquals(379, stats.audioPacketsReceived)
    }

    @Test
    fun `plain numbers are read too`() {
        val report = reportOf(
            stat(
                "outbound-rtp",
                "out-1",
                "kind" to "audio",
                "bytesSent" to 4_096L,
                "packetsSent" to 100,
            ),
        )
        val stats = parseMediaStats(report)
        assertEquals(4_096, stats.audioBytesSent)
        assertEquals(100, stats.audioPacketsSent)
    }

    @Test
    fun `the selected candidate pair is followed to its candidate types`() {
        val report = reportOf(
            stat("transport", "T1", "selectedCandidatePairId" to "P1"),
            stat(
                "candidate-pair",
                "P1",
                "localCandidateId" to "L1",
                "remoteCandidateId" to "R1",
                "currentRoundTripTime" to 0.002,
            ),
            stat(
                "local-candidate",
                "L1",
                "candidateType" to "relay",
                "protocol" to "udp",
                "relayProtocol" to "tcp",
            ),
            stat("remote-candidate", "R1", "candidateType" to "srflx"),
        )
        val stats = parseMediaStats(report)
        assertEquals("relay", stats.localCandidateType)
        assertEquals("srflx", stats.remoteCandidateType)
        assertEquals("udp", stats.candidateProtocol)
        assertEquals("tcp", stats.relayProtocol)
        assertEquals(2.0, stats.currentRoundTripTimeMs!!, 0.001)
    }

    @Test
    fun `a report with no transport falls back to the nominated pair`() {
        val report = reportOf(
            stat(
                "candidate-pair",
                "P9",
                "state" to "succeeded",
                "nominated" to true,
                "localCandidateId" to "L9",
                "remoteCandidateId" to "R9",
            ),
            stat("local-candidate", "L9", "candidateType" to "host"),
            stat("remote-candidate", "R9", "candidateType" to "host"),
        )
        val stats = parseMediaStats(report)
        assertEquals("host", stats.localCandidateType)
        assertEquals("host", stats.remoteCandidateType)
    }

    @Test
    fun `a pair that only failed is not reported as selected`() {
        val report = reportOf(
            stat(
                "candidate-pair",
                "P9",
                "state" to "failed",
                "nominated" to false,
                "localCandidateId" to "L9",
                "remoteCandidateId" to "R9",
            ),
            stat("local-candidate", "L9", "candidateType" to "host"),
        )
        assertNull(parseMediaStats(report).localCandidateType)
    }

    @Test
    fun `the video size is read at the receiver, not from the sender`() {
        // A bitrate ceiling is not a resolution: the size that matters is the
        // one on the inbound stream.
        val report = reportOf(
            stat(
                "inbound-rtp",
                "in-v",
                "kind" to "video",
                "bytesReceived" to BigInteger.valueOf(58_541),
                "frameWidth" to 720L,
                "frameHeight" to 1_606L,
                "framesPerSecond" to 3.0,
            ),
            stat(
                "outbound-rtp",
                "out-v",
                "kind" to "video",
                "bytesSent" to BigInteger.ZERO,
                "frameWidth" to 1_920L,
                "frameHeight" to 1_080L,
            ),
        )
        val stats = parseMediaStats(report)
        assertEquals(720, stats.videoFrameWidth)
        assertEquals(1_606, stats.videoFrameHeight)
        // The sender's own idea is kept separately and never conflated.
        assertEquals(1_920, stats.sentFrameWidth)
    }

    @Test
    fun `playout samples and levels come through`() {
        val report = reportOf(
            stat(
                "inbound-rtp",
                "in-1",
                "kind" to "audio",
                "totalSamplesReceived" to BigInteger.valueOf(120_480),
                "concealedSamples" to BigInteger.valueOf(12),
                "audioLevel" to 0.42,
            ),
            stat("media-source", "src-1", "kind" to "audio", "audioLevel" to 0.7),
        )
        val stats = parseMediaStats(report)
        assertEquals(120_480, stats.totalSamplesReceived)
        assertEquals(12, stats.concealedSamples)
        assertEquals(0.42, stats.inboundAudioLevel, 0.0001)
        assertEquals(0.7, stats.micAudioLevel, 0.0001)
    }

    @Test
    fun `a report missing everything reads as zero rather than throwing`() {
        val stats = parseMediaStats(reportOf(stat("inbound-rtp", "in-1", "kind" to "audio")))
        assertEquals(0, stats.audioBytesReceived)
        assertEquals(0, stats.audioPacketsReceived)
        assertNull(stats.localCandidateType)
    }

    @Test
    fun `the summary names the pair and the counters`() {
        val summary = PeerMediaStats(
            audioBytesReceived = 15_183,
            audioPacketsReceived = 379,
            localCandidateType = "relay",
            remoteCandidateType = "relay",
        ).summary()
        // The one line somebody reads in logcat to settle "can they hear me".
        assertEquals(true, summary.contains("pair=relay/relay"))
        assertEquals(true, summary.contains("rx=15183B/379pkt"))
    }

    // --- helpers ---

    private fun stat(type: String, id: String, vararg members: Pair<String, Any>): RTCStats =
        RTCStats(0L, type, id, members.toMap())

    private fun reportOf(vararg stats: RTCStats): RTCStatsReport =
        RTCStatsReport(0L, stats.associateBy { it.id })
}
