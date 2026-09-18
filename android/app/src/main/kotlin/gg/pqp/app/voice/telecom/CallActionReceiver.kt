package gg.pqp.app.voice.telecom

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import gg.pqp.app.PqpApplication

/**
 * Answer / Decline from [IncomingCallNotifier]'s `CallStyle` actions.
 *
 * Calls straight into `PqpApplication.calls` — the same
 * [gg.pqp.app.voice.CallController] methods the in-app `IncomingCallBanner`
 * calls — rather than into `android.telecom` or [PqpConnection]. `TelecomController`
 * is what watches `CallController` and `VoiceController` and keeps the
 * Telecom connection in step; a second path here that poked the connection
 * directly would be a second thing that could disagree with the first.
 *
 * `exported="false"` in the manifest: only this process's own PendingIntents
 * may reach it.
 */
class CallActionReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val roomId = intent.getStringExtra(EXTRA_ROOM_ID) ?: return
        val app = context.applicationContext as? PqpApplication ?: return
        when (intent.action) {
            ACTION_ANSWER -> app.calls.accept(roomId)
            ACTION_DECLINE -> app.calls.decline(roomId)
        }
    }

    companion object {
        const val ACTION_ANSWER = "gg.pqp.app.telecom.ANSWER"
        const val ACTION_DECLINE = "gg.pqp.app.telecom.DECLINE"
        private const val EXTRA_ROOM_ID = "gg.pqp.app.telecom.ROOM_ID"

        fun intent(context: Context, action: String, roomId: String): Intent =
            Intent(context, CallActionReceiver::class.java)
                .setAction(action)
                .putExtra(EXTRA_ROOM_ID, roomId)
                // Distinguishes this PendingIntent from the other action's, so
                // FLAG_UPDATE_CURRENT does not collapse Answer and Decline
                // for the same room into whichever was built last.
                .setData(android.net.Uri.fromParts("pqp-call-action", "$action:$roomId", null))
    }
}
