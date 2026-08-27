package gg.pqp.app

import android.app.Application
import android.os.Build
import coil3.ImageLoader
import coil3.PlatformContext
import coil3.SingletonImageLoader
import coil3.gif.AnimatedImageDecoder
import coil3.gif.GifDecoder
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
     *
     * The decoder is the other half, and it used to be missing. Coil decodes
     * still images with no help, so an app with no animated decoder registered
     * does not fail on a GIF: it draws frame one and stops, which is how a
     * first-class feature (the GIF picker, `GET /api/gifs/config`) arrived on
     * Android as a frozen picture that nobody could tell from a bad GIF.
     *
     * `coil-gif` does publish a `ServiceLoader` entry, so on a debug build the
     * artifact alone would have been enough. It is registered by hand anyway,
     * because the release build is minified and shrunk and a decoder that only
     * exists via `META-INF/services` is a decoder whose presence depends on
     * R8 keeping a resource nobody references. This block is a reference.
     *
     * Two factories, not one: `AnimatedImageDecoder` is `@RequiresApi(28)`,
     * because it is `android.graphics.ImageDecoder` underneath, and `minSdk`
     * here is 26. This is the same split Coil's own service-loader entry
     * makes. The API 28 path is the better one where it exists, because it
     * animates WebP and (on 30+) HEIF as well as GIF and Tenor serves plenty
     * of animated WebP, so 26 and 27 fall back to the `Movie`-based decoder
     * and animate GIF only.
     */
    override fun newImageLoader(context: PlatformContext): ImageLoader =
        ImageLoader.Builder(context)
            .components {
                add(OkHttpNetworkFetcherFactory(callFactory = { http }))
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    add(AnimatedImageDecoder.Factory())
                } else {
                    add(GifDecoder.Factory())
                }
            }
            .build()
}
