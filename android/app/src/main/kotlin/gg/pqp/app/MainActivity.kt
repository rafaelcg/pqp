package gg.pqp.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import gg.pqp.app.ui.PqpApp
import gg.pqp.app.ui.theme.Palette
import gg.pqp.app.ui.theme.PqpTheme

class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        val splash = installSplashScreen()
        super.onCreate(savedInstanceState)

        val app = application as PqpApplication

        // Hold the splash only while the session is still being restored, and
        // never longer: `SessionStore.restore` carries its own deadline, so
        // this cannot become an app stranded on a logo.
        splash.setKeepOnScreenCondition {
            app.session.phase.value is gg.pqp.app.core.SessionPhase.Launching
        }

        // Edge to edge, with transparent system bars the content draws behind.
        //
        // `auto` rather than `dark`: the bar *icons* have to follow the theme,
        // and pinning them light painted white icons onto the light scheme's
        // near-white ground, where the clock and the battery disappeared
        // outright. Caught on the emulator, which boots in light mode.
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.auto(
                android.graphics.Color.TRANSPARENT,
                android.graphics.Color.TRANSPARENT,
            ),
            navigationBarStyle = SystemBarStyle.auto(
                android.graphics.Color.TRANSPARENT,
                android.graphics.Color.TRANSPARENT,
            ),
        )

        // Debug-only: `--es pqp.devUser bob` mints a *separate* dev-bypass
        // identity server-side (`dev_local_user_bob`). Two emulators otherwise
        // share one account, which makes it impossible to test the two things
        // that only appear between two different clients: voice negotiation and
        // a message arriving from somebody else. Mirrors `PQP_DEV_USER` on iOS.
        val devUser = if (BuildConfig.DEBUG) intent?.getStringExtra("pqp.devUser") else null
        if (devUser != null) {
            app.session.useDevAccount(devUser)
        } else if (app.session.phase.value is gg.pqp.app.core.SessionPhase.Launching) {
            app.session.restore()
        }

        // A tapped notification, which on a cold start is already on the
        // intent by the time this runs. The target is parked on the controller
        // rather than acted on here: there is no NavController until the tree
        // below is composed, and the session may still be launching.
        app.push.onActivityIntent(intent)

        setContent {
            PqpTheme {
                PqpApp(session = app.session, voice = app.voice, push = app.push)
            }
        }
    }

    /**
     * A tap while the app is already running. `MainActivity` is launched
     * SINGLE_TOP from the notification, so the second tap arrives here instead
     * of creating a second Activity.
     *
     * `setIntent` first, because `getIntent()` otherwise keeps answering with
     * the one that started the process.
     */
    override fun onNewIntent(intent: android.content.Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        (application as PqpApplication).push.onActivityIntent(intent)
    }
}

/** Kept beside the activity so the splash and the first frame agree. */
internal val SplashBackground = Palette.Ink
