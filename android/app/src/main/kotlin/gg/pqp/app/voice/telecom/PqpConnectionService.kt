package gg.pqp.app.voice.telecom

import android.telecom.Connection
import android.telecom.ConnectionRequest
import android.telecom.ConnectionService
import android.telecom.DisconnectCause
import android.telecom.PhoneAccountHandle
import android.util.Log

/**
 * Where the system asks pqp to build a [Connection], for a call this app
 * placed or one it declared incoming through `TelecomManager`.
 *
 * Bound by the system (`BIND_TELECOM_CONNECTION_SERVICE` in the manifest),
 * never started or reached directly by this app's own code — the only door
 * in is [AndroidTelecomGateway] asking `TelecomManager` for a call, which is
 * what makes the system call back in here a moment later. `roomId` travels
 * in as an extra on the very request [AndroidTelecomGateway] built, so a
 * connection created here always knows which voice room it is for, with
 * nothing to look up.
 */
class PqpConnectionService : ConnectionService() {

    override fun onCreateOutgoingConnection(
        connectionManagerPhoneAccount: PhoneAccountHandle,
        request: ConnectionRequest,
    ): Connection = build(request, incoming = false)

    override fun onCreateOutgoingConnectionFailed(
        connectionManagerPhoneAccount: PhoneAccountHandle,
        request: ConnectionRequest,
    ) {
        val roomId = request.extras?.getString(AndroidTelecomGateway.EXTRA_ROOM_ID)
        Log.w(TAG, "outgoing connection refused for $roomId")
        // The underlying pqp call is unaffected -- only Telecom's own
        // bookkeeping needs to hear about this, so it stops believing a
        // connection exists for a room Telecom itself just refused (Farol
        // review, PR 678).
        roomId?.let { TelecomBridge.callbacks?.onConnectionFailed(it) }
    }

    override fun onCreateIncomingConnection(
        connectionManagerPhoneAccount: PhoneAccountHandle,
        request: ConnectionRequest,
    ): Connection = build(request, incoming = true)

    override fun onCreateIncomingConnectionFailed(
        connectionManagerPhoneAccount: PhoneAccountHandle,
        request: ConnectionRequest,
    ) {
        val roomId = request.extras?.getString(AndroidTelecomGateway.EXTRA_ROOM_ID)
        Log.w(TAG, "incoming connection refused for $roomId")
        roomId?.let { TelecomBridge.callbacks?.onConnectionFailed(it) }
    }

    private fun build(request: ConnectionRequest, incoming: Boolean): Connection {
        val roomId = request.extras?.getString(AndroidTelecomGateway.EXTRA_ROOM_ID)
        val displayName = request.extras?.getString(AndroidTelecomGateway.EXTRA_DISPLAY_NAME)
        if (roomId == null) {
            // No room id means this request did not come from
            // AndroidTelecomGateway (nothing else in this app calls
            // TelecomManager), so there is nothing to build a call around.
            return Connection.createFailedConnection(DisconnectCause(DisconnectCause.ERROR))
        }
        val connection = PqpConnection(roomId).apply {
            applyAddress(request.address, displayName ?: roomId)
            if (incoming) setRinging() else setDialing()
        }
        TelecomBridge.register(roomId, connection)
        return connection
    }

    companion object {
        private const val TAG = "pqp.telecom"
    }
}
