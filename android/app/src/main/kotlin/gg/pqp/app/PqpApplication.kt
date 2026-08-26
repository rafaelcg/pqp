package gg.pqp.app

import android.app.Application
import coil3.ImageLoader
import coil3.PlatformContext
import coil3.SingletonImageLoader
import coil3.network.okhttp.OkHttpNetworkFetcherFactory
import com.clerk.api.Clerk
import gg.pqp.app.core.AuthMode
import gg.pqp.app.core.Backend
import gg.pqp.app.core.SessionStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.plus
import okhttp3.OkHttpClient

class PqpApplication : Application(), SingletonImageLoader.Factory {

    /**
     * Application-scoped on purpose. A call and its socket outlive the Activity
     * that started them, and an Activity-scoped scope would cancel both on the
     * first rotation.
     */
    private val appScope = CoroutineScope(SupervisorJob()) + kotlinx.coroutines.Dispatchers.Main.immediate

    lateinit var http: OkHttpClient
        private set

    lateinit var session: SessionStore
        private set

    /**
     * Application-scoped because a call outlives every Activity that will be
     * created for it, and because `VoiceService` has to be able to reach it
     * from a notification action with no UI in the process at all.
     */
    lateinit var voice: gg.pqp.app.voice.VoiceController
        private set

    /**
     * Application-scoped because a push can arrive, be drawn and be tapped with
     * no Activity in the process at all.
     */
    lateinit var push: gg.pqp.app.push.PushController
        private set

    override fun onCreate() {
        super.onCreate()

        // Clerk is only started when there is a key to start it with. Without
        // one the app runs on the dev bypass, which reaches a local server and
        // nothing else; initialising Clerk with an empty string instead fails
        // later, somewhere much less obvious.
        if (Backend.authMode == AuthMode.Clerk) {
            Clerk.initialize(this, requireNotNull(Backend.clerkPublishableKey))
        }

        http = gg.pqp.app.core.ApiClient.defaultHttpClient()
        session = SessionStore(appScope, http)
        voice = gg.pqp.app.voice.VoiceController(this, session, appScope)
        push = gg.pqp.app.push.PushController(this, session, appScope)
    }

    /**
     * Avatars and attachments come from the same hosts as the API, so Coil
     * shares its connection pool rather than opening a second one.
     */
    override fun newImageLoader(context: PlatformContext): ImageLoader =
        ImageLoader.Builder(context)
            .components { add(OkHttpNetworkFetcherFactory(callFactory = { http })) }
            .build()
}
