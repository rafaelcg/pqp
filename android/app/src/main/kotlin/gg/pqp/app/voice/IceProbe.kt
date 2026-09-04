package gg.pqp.app.voice

import android.content.Context
import gg.pqp.app.core.IceProbeResult
import gg.pqp.app.core.IceProber
import gg.pqp.app.core.IceServer
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription

/**
 * Gathers ICE candidates against a list of servers and says which kinds
 * turned up. A server-reflexive candidate is proof STUN answered; a relay
 * candidate is proof a call could work from behind this network. No
 * candidates at all usually means UDP is blocked outright.
 *
 * A throwaway factory rather than `VoiceEngine`'s: that one is built once
 * with an audio device module and a GL context, and it may not exist yet, or
 * be mid-call. This one has no media at all, only a data channel, which is
 * enough to make the stack gather.
 */
class WebRtcIceProber(private val context: Context) : IceProber {
    override suspend fun probe(
        servers: List<IceServer>,
        relayOnly: Boolean,
        timeoutMs: Long,
    ): IceProbeResult = withContext(Dispatchers.Default) {
        // Idempotent: the engine may already have done this, and the library
        // guards its own native load.
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(context.applicationContext)
                .createInitializationOptions(),
        )
        val factory = PeerConnectionFactory.builder().createPeerConnectionFactory()
        val ice = servers.flatMap { server ->
            server.urlList.map { url ->
                PeerConnection.IceServer.builder(url)
                    .setUsername(server.username.orEmpty())
                    .setPassword(server.credential.orEmpty())
                    .createIceServer()
            }
        }
        val config = PeerConnection.RTCConfiguration(ice).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            if (relayOnly) iceTransportsType = PeerConnection.IceTransportsType.RELAY
        }

        val done = CompletableDeferred<Unit>()
        val host = AtomicBoolean(false)
        val srflx = AtomicBoolean(false)
        val relay = AtomicBoolean(false)

        val observer = object : PeerConnection.Observer {
            override fun onIceCandidate(candidate: IceCandidate) {
                val sdp = candidate.sdp
                when {
                    sdp.contains(" typ relay") -> relay.set(true)
                    sdp.contains(" typ srflx") -> srflx.set(true)
                    sdp.contains(" typ host") -> host.set(true)
                }
                // Relay is the answer we came for; stop as soon as we have it.
                if (relayOnly && relay.get()) done.complete(Unit)
                if (!relayOnly && srflx.get()) done.complete(Unit)
            }

            override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {
                if (state == PeerConnection.IceGatheringState.COMPLETE) done.complete(Unit)
            }

            override fun onSignalingChange(state: PeerConnection.SignalingState) = Unit
            override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) = Unit
            override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit
            override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) = Unit
            override fun onAddStream(stream: MediaStream) = Unit
            override fun onRemoveStream(stream: MediaStream) = Unit
            override fun onDataChannel(channel: DataChannel) = Unit
            override fun onRenegotiationNeeded() = Unit
        }

        val connection = factory.createPeerConnection(config, observer)
        if (connection == null) {
            factory.dispose()
            return@withContext IceProbeResult(host = false, srflx = false, relay = false)
        }
        try {
            connection.createDataChannel("probe", DataChannel.Init())
            connection.createOffer(
                object : SdpObserver {
                    override fun onCreateSuccess(description: SessionDescription) {
                        connection.setLocalDescription(this, description)
                    }

                    override fun onSetSuccess() = Unit

                    override fun onCreateFailure(error: String?) {
                        done.complete(Unit)
                    }

                    override fun onSetFailure(error: String?) {
                        done.complete(Unit)
                    }
                },
                MediaConstraints(),
            )
            withTimeoutOrNull(timeoutMs) { done.await() }
            IceProbeResult(host = host.get(), srflx = srflx.get(), relay = relay.get())
        } finally {
            connection.close()
            connection.dispose()
            factory.dispose()
        }
    }
}
