package gg.pqp.app.push

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import gg.pqp.app.PqpApplication

/**
 * Where FCM hands this app a message, and a rotated token.
 *
 * Thin on purpose. The service is constructed by the system with no arguments
 * and lives for the length of one callback, so it owns nothing: both methods
 * hand straight to the application-scoped [PushController], which is the object
 * that outlives every Activity and knows whether anything is on screen.
 *
 * `onMessageReceived` is called for **data** messages only, and only those. A
 * message carrying a `notification` block is drawn by the Firebase SDK itself
 * while the app is backgrounded, without ever reaching this method, which would
 * take away the one decision this client has to make: whether the person is
 * already reading the channel being announced. The server's FCM leg must send
 * data-only payloads; see the note on [PushMessage].
 */
class PqpMessagingService : FirebaseMessagingService() {

    private val controller: PushController?
        get() = (application as? PqpApplication)?.push

    /**
     * A rotated registration token.
     *
     * DEPRECATED, AND USED ANYWAY, DELIBERATELY. Firebase 25.1.2 points this at
     * `onRegistered`, but the two do not hand over the same value:
     * `onNewToken` yields an **FCM registration token**, which is what the
     * `token` field of every FCM HTTP v1 send takes and what every server SDK
     * is written against, while `onRegistered` yields a **Firebase Installation
     * ID**, which needs a different manifest opt-in
     * (`firebase_messaging_installation_id_enabled`) and a server able to
     * target FIDs. Switching would change the server contract that does not
     * exist yet from the ordinary one to the unusual one, on a path nobody can
     * test here. The deprecated method still works and is still shipped;
     * migrating it is a note in docs/ANDROID.md, not a guess made today.
     */
    @Suppress("OVERRIDE_DEPRECATION")
    override fun onNewToken(token: String) {
        controller?.onTokenRefreshed(token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        controller?.onMessageReceived(message.data)
    }
}
