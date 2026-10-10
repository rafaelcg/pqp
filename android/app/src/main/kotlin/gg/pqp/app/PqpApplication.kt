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
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
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

    /**
     * Application-scoped for the same reason [voice] is, and one reason more:
     * a ring arrives whatever screen is open, and `call-incoming` has to be
     * caught even when the person is nowhere near the conversation it is for.
     */
    lateinit var calls: gg.pqp.app.voice.CallController
        private set

    /**
     * Application-scoped for the same reason [voice] and [calls] are: a call
     * outlives every Activity, and Telecom itself hands connections to
     * `PqpConnectionService` on its own schedule with no Activity in the
     * process at all.
     */
    lateinit var telecom: gg.pqp.app.voice.telecom.TelecomController
        private set

    /**
     * Application-scoped for one reason the others do not have: the watcher
     * count is per socket, and this is what re-announces a watch after a
     * reconnect. Tied to a screen it would forget the moment somebody rotated
     * the phone mid-party.
     */
    lateinit var watch: gg.pqp.app.watch.WatchLiveStore
        private set

    /**
     * Application-scoped for the same reason [calls] is: hosting is a call
     * (the screen share reuses [voice] directly), so it has to outlive
     * whatever screen started it in the same way an ordinary call does.
     */
    lateinit var watchPartyHost: gg.pqp.app.watch.WatchPartyHostController
        private set

    /**
     * Whether a pqp call is live on this device. One flow, read by the voice
     * note recorder (which refuses to open the microphone) and by the player
     * (which refuses to take audio focus), so neither can disagree with the
     * call about whether there is one.
     */
    lateinit var callActive: kotlinx.coroutines.flow.StateFlow<Boolean>
        private set

    /**
     * Application-scoped for the reason the voice note player is one player:
     * leaving a chat must not cut a note off halfway, and the next unheard
     * note still has to start when this one ends.
     */
    lateinit var voiceNotes: gg.pqp.app.voicenotes.VoiceNotes
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
        calls = gg.pqp.app.voice.CallController(this, session, voice, appScope)
        telecom = gg.pqp.app.voice.telecom.TelecomController(this, voice, calls, appScope)
        watch = gg.pqp.app.watch.WatchLiveStore(
            frames = session.realtime.frames,
            realtimeState = session.realtime.state,
            send = { session.realtime.send(it) },
            // Read lazily rather than captured: a seat comes and goes for the
            // whole life of this object, and a snapshot taken here would be
            // the answer from before anybody had joined anything.
            seatedChannelId = { voice.state.value.channelId.takeIf { _ -> voice.state.value.isActive } },
            seed = { channelId -> runCatching { session.api.channelLive(channelId) }.getOrNull() },
            scope = appScope,
        )
        watchPartyHost = gg.pqp.app.watch.WatchPartyHostController(this, session, voice, appScope)

        callActive = voice.state
            .map { it.isActive }
            .distinctUntilChanged()
            .stateIn(appScope, SharingStarted.Eagerly, false)
        voiceNotes = gg.pqp.app.voicenotes.VoiceNotes(
            context = this,
            scope = appScope,
            reportListened = { id -> gg.pqp.app.attachments.AttachmentApi(session.api).listened(id) },
            freshUrl = { id -> runCatching { session.api.attachmentUrl(id) }.getOrNull() },
            frames = session.realtime.frames,
            myId = { (session.phase.value as? gg.pqp.app.core.SessionPhase.Ready)?.me?.id },
            callActive = callActive,
        )
        registerActivityLifecycleCallbacks(BackgroundPause { voiceNotes.onAppBackgrounded() })
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

/**
 * Calls [onBackground] once the last visible Activity has stopped.
 *
 * A voice note is not a call: it has no foreground service and no media
 * session, so it must not keep playing into a locked pocket. Counting started
 * Activities (rather than listening for the screen turning off) also covers
 * the app being swiped away to another one. A configuration change stops and
 * restarts the Activity in the same breath, which is why that stop is not
 * counted as leaving.
 */
private class BackgroundPause(private val onBackground: () -> Unit) :
    android.app.Application.ActivityLifecycleCallbacks {
    private var started = 0

    override fun onActivityStarted(activity: android.app.Activity) {
        started += 1
    }

    override fun onActivityStopped(activity: android.app.Activity) {
        started = (started - 1).coerceAtLeast(0)
        if (started == 0 && !activity.isChangingConfigurations) onBackground()
    }

    override fun onActivityCreated(activity: android.app.Activity, savedInstanceState: android.os.Bundle?) = Unit
    override fun onActivityResumed(activity: android.app.Activity) = Unit
    override fun onActivityPaused(activity: android.app.Activity) = Unit
    override fun onActivitySaveInstanceState(activity: android.app.Activity, outState: android.os.Bundle) = Unit
    override fun onActivityDestroyed(activity: android.app.Activity) = Unit
}
