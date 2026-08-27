package gg.pqp.app.push

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import gg.pqp.app.PqpApplication

/**
 * Feeds a fake push into the real delivery path, from `adb`.
 *
 * DEBUG BUILDS ONLY, this file lives in `src/debug` and is not compiled into a
 * release APK, which matters because an exported receiver that can draw any
 * notification it likes is a phishing surface.
 *
 * It exists because the one thing that cannot be exercised on this machine is
 * FCM itself: there is no Firebase project, so no token, so no delivery. What
 * *can* be exercised is everything after delivery, which is where all of this
 * client's behaviour lives, the redundancy check, the notification, the
 * collapsing, and the tap landing on the right channel. This is the same idea
 * as `setPushSenderForTests` in `server/src/services/push.ts`: substitute the
 * transport, keep the pipeline.
 *
 * It enters at [PushController.onMessageReceived], the exact method
 * [PqpMessagingService] calls, with a data map shaped exactly as the server's
 * FCM leg would send. Nothing downstream can tell the difference.
 *
 *     adb shell am broadcast -a gg.pqp.app.debug.PUSH \
 *       -n gg.pqp.app.debug/gg.pqp.app.push.PushDebugReceiver \
 *       --es title '#geral' --es body 'Rafael mentioned you' \
 *       --es path '/app/server/<sid>/channel/<cid>' --es tag '<cid>'
 */
class PushDebugReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val app = context.applicationContext as? PqpApplication ?: return
        val data = buildMap {
            intent.getStringExtra("title")?.let { put(PushMessage.KEY_TITLE, it) }
            intent.getStringExtra("body")?.let { put(PushMessage.KEY_BODY, it) }
            intent.getStringExtra("path")?.let { put(PushMessage.KEY_PATH, it) }
            intent.getStringExtra("tag")?.let { put(PushMessage.KEY_TAG, it) }
        }
        app.push.onMessageReceived(data)
    }
}
