package gg.pqp.app.voice

import java.math.BigInteger
import org.webrtc.RTCStats
import org.webrtc.RTCStatsReport

/**
 * What one peer connection is actually carrying, as opposed to what it says.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT DEBUG SCAFFOLDING.
 * `PeerConnectionState.CONNECTED` means ICE found a path and DTLS completed.
 * It does not mean a single audio packet arrived, and this project has been
 * caught by exactly that distinction more than once: a call bar reading
 * "2 in this call" while both sides sat in silence. The only evidence that
 * somebody can hear somebody is a receive counter that climbs, so the counter
 * is read, logged, and allowed to contradict the connection state.
 *
 * Everything here is a pure function of an [RTCStatsReport], so the parsing
 * (which is the part that silently returns zero when a field is renamed) can
 * be exercised without a peer connection.
 */
data class PeerMediaStats(
    /** Cumulative, since the connection was created. */
    val audioBytesReceived: Long = 0,
    val audioPacketsReceived: Long = 0,
    val audioBytesSent: Long = 0,
    val audioPacketsSent: Long = 0,
    /** Screen share, when one is on the wire in either direction. */
    val videoBytesReceived: Long = 0,
    val videoPacketsReceived: Long = 0,
    val videoBytesSent: Long = 0,
    /**
     * The size the far end's video **arrives** at, which is the only size worth
     * believing.
     *
     * A bitrate ceiling is not a resolution: the web client shipped a quality
     * menu whose lower rungs still delivered 1920x1080, starved of bits rather
     * than scaled, and nobody noticed because the sender was asked what it was
     * sending. These two fields are read at the receiver.
     */
    val videoFrameWidth: Int = 0,
    val videoFrameHeight: Int = 0,
    val videoFramesPerSecond: Double = 0.0,
    /**
     * PCM the jitter buffer has handed to the audio device.
     *
     * The half of the path that packet counters cannot see. Bytes arriving
     * proves the network; samples arriving proves the decoder ran and the
     * playout side took them, which is the last step before a speaker.
     */
    val totalSamplesReceived: Long = 0,
    /** Samples the concealer invented for packets that never came. */
    val concealedSamples: Long = 0,
    /**
     * Loudness of what arrived, 0 to 1, and of what this device's microphone
     * captured.
     *
     * The only two numbers in this file that are about *sound* rather than
     * about traffic. A call can carry a perfect stream of encoded silence.
     */
    val inboundAudioLevel: Double = 0.0,
    val micAudioLevel: Double = 0.0,
    /** The size this device is sending its screen at, as the encoder sees it. */
    val sentFrameWidth: Int = 0,
    val sentFrameHeight: Int = 0,
    /** `host`, `srflx`, `prflx` or `relay` on the pair ICE actually chose. */
    val localCandidateType: String? = null,
    val remoteCandidateType: String? = null,
    /** `udp` or `tcp`, and for a relay pair the protocol used to the TURN server. */
    val candidateProtocol: String? = null,
    val relayProtocol: String? = null,
    val currentRoundTripTimeMs: Double? = null,
) {
    /** One line, for `adb logcat -s pqp.voice`. */
    fun summary(): String = buildString {
        append("pair=")
        append(localCandidateType ?: "?")
        append("/")
        append(remoteCandidateType ?: "?")
        candidateProtocol?.let { append(" ").append(it) }
        relayProtocol?.let { append(" via ").append(it) }
        append(" audio rx=").append(audioBytesReceived).append("B/")
        append(audioPacketsReceived).append("pkt")
        append(" tx=").append(audioBytesSent).append("B/")
        append(audioPacketsSent).append("pkt")
        append(" samples=").append(totalSamplesReceived)
        append(" concealed=").append(concealedSamples)
        append(" level=").append(String.format("%.4f", inboundAudioLevel))
        append(" mic=").append(String.format("%.4f", micAudioLevel))
        if (videoBytesReceived > 0 || videoBytesSent > 0) {
            append(" video rx=").append(videoBytesReceived).append("B")
            if (videoFrameWidth > 0) {
                append(" @").append(videoFrameWidth).append("x").append(videoFrameHeight)
                append("@").append(String.format("%.0f", videoFramesPerSecond)).append("fps")
            }
            append(" tx=").append(videoBytesSent).append("B")
            if (sentFrameWidth > 0) {
                append(" @").append(sentFrameWidth).append("x").append(sentFrameHeight)
            }
        }
        currentRoundTripTimeMs?.let { append(" rtt=").append(String.format("%.0f", it)).append("ms") }
    }
}

/**
 * Pull the handful of numbers that matter out of a full stats report.
 *
 * The report is a flat map of a few hundred entries joined by id, so the
 * selected candidate pair has to be followed by reference: `transport` names a
 * pair, the pair names two candidates, and only the candidates carry the type.
 * The fallback for a report with no `transport` entry is the nominated pair in
 * a succeeded state, which is the same pair by another route.
 */
fun parseMediaStats(report: RTCStatsReport): PeerMediaStats {
    val stats = report.statsMap
    var result = PeerMediaStats()

    for (entry in stats.values) {
        when (entry.type) {
            "inbound-rtp" -> when (entry.string("kind")) {
                "audio" -> result = result.copy(
                    audioBytesReceived = result.audioBytesReceived + entry.long("bytesReceived"),
                    audioPacketsReceived =
                        result.audioPacketsReceived + entry.long("packetsReceived"),
                    totalSamplesReceived =
                        result.totalSamplesReceived + entry.long("totalSamplesReceived"),
                    concealedSamples = result.concealedSamples + entry.long("concealedSamples"),
                    inboundAudioLevel =
                        maxOf(result.inboundAudioLevel, entry.double("audioLevel") ?: 0.0),
                )

                "video" -> result = result.copy(
                    videoBytesReceived = result.videoBytesReceived + entry.long("bytesReceived"),
                    videoPacketsReceived =
                        result.videoPacketsReceived + entry.long("packetsReceived"),
                    videoFrameWidth = maxOf(result.videoFrameWidth, entry.int("frameWidth")),
                    videoFrameHeight = maxOf(result.videoFrameHeight, entry.int("frameHeight")),
                    videoFramesPerSecond =
                        maxOf(result.videoFramesPerSecond, entry.double("framesPerSecond") ?: 0.0),
                )
            }

            "media-source" -> if (entry.string("kind") == "audio") {
                result = result.copy(
                    micAudioLevel =
                        maxOf(result.micAudioLevel, entry.double("audioLevel") ?: 0.0),
                )
            }

            "outbound-rtp" -> when (entry.string("kind")) {
                "audio" -> result = result.copy(
                    audioBytesSent = result.audioBytesSent + entry.long("bytesSent"),
                    audioPacketsSent = result.audioPacketsSent + entry.long("packetsSent"),
                )

                "video" -> result = result.copy(
                    videoBytesSent = result.videoBytesSent + entry.long("bytesSent"),
                    sentFrameWidth = maxOf(result.sentFrameWidth, entry.int("frameWidth")),
                    sentFrameHeight = maxOf(result.sentFrameHeight, entry.int("frameHeight")),
                )
            }
        }
    }

    val pair = selectedPair(stats) ?: return result
    val local = stats[pair.string("localCandidateId")]
    val remote = stats[pair.string("remoteCandidateId")]
    return result.copy(
        localCandidateType = local?.string("candidateType"),
        remoteCandidateType = remote?.string("candidateType"),
        candidateProtocol = local?.string("protocol"),
        relayProtocol = local?.string("relayProtocol"),
        currentRoundTripTimeMs = pair.double("currentRoundTripTime")?.let { it * 1000.0 },
    )
}

private fun selectedPair(stats: Map<String, RTCStats>): RTCStats? {
    val named = stats.values
        .firstOrNull { it.type == "transport" }
        ?.string("selectedCandidatePairId")
    if (named != null) {
        stats[named]?.let { return it }
    }
    return stats.values.firstOrNull {
        it.type == "candidate-pair" &&
            it.string("state") == "succeeded" &&
            it.members["nominated"] == true
    }
}

private fun RTCStats.string(key: String): String? = members[key] as? String

/**
 * WebRTC's bridge hands unsigned counters over as [BigInteger], smaller ones as
 * [Integer] or [Long], and a missing field as null. Reading one as a `Long`
 * cast returns null for two of those three, which would report a healthy call
 * as silent.
 */
private fun RTCStats.long(key: String): Long = when (val value = members[key]) {
    is BigInteger -> value.toLong()
    is Number -> value.toLong()
    else -> 0L
}

private fun RTCStats.int(key: String): Int = long(key).toInt()

private fun RTCStats.double(key: String): Double? = (members[key] as? Number)?.toDouble()
