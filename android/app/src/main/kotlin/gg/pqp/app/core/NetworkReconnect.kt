package gg.pqp.app.core

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Handler
import android.os.Looper

/**
 * Reconnect the moment the phone gets a network back, instead of when the
 * socket's backoff next wakes up.
 *
 * Without this the "Offline" bar outlived the outage by however long the
 * backoff had grown while the radio was off (about eleven seconds in a test),
 * even though the network was up and a try would have worked. The system tells
 * us the moment a default network becomes available; that is the cue to cut the
 * wait short, exactly as the banner's "Try now" does.
 */
object NetworkReconnect {

    /**
     * Only a socket that is trying and not connected is nudged. A connected one has nothing to fix, one that was never
     * wanted (signed out) must not be started by the network coming back, and one the server refused would only be
     * refused again.
     */
    fun shouldRetry(state: RealtimeState): Boolean =
        state == RealtimeState.Connecting || state == RealtimeState.Reconnecting

    fun register(context: Context, session: SessionStore) {
        val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
        val main = Handler(Looper.getMainLooper())
        runCatching {
            manager.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) = nudge()

                // A network is often available a moment before the system has checked that it reaches the internet:
                // the second cue is the check passing.
                override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
                    if (capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)) nudge()
                }

                private fun nudge() {
                    // The client keeps its state on the main thread.
                    main.post {
                        if (shouldRetry(session.realtime.state.value)) session.realtime.retryNow()
                    }
                }
            })
        }
    }
}
