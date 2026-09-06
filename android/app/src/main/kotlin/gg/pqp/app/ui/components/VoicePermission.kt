package gg.pqp.app.ui.components

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat

/**
 * "Do the thing that needs the microphone", asking first when it must.
 *
 * The same two permissions `ChannelsScreen` asks for before a voice channel,
 * for the same reasons written there: only the microphone gates the call, and
 * notifications are asked in the same breath because the foreground service's
 * notification is how a person gets back to a call. The answer is read back
 * from the permission itself, not from the results map, which only carries
 * what was asked this time.
 *
 * Returns a launcher: call it with the action, and the action runs now or
 * after a grant. A refusal calls [onDenied] instead.
 */
@Composable
fun rememberMicrophoneGate(onDenied: () -> Unit = {}): (() -> Unit) -> Unit {
    val context = LocalContext.current
    val pending = remember { arrayOfNulls<() -> Unit>(1) }

    val launcher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { _ ->
        val action = pending[0]
        pending[0] = null
        val granted =
            ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
                PackageManager.PERMISSION_GRANTED
        if (granted) action?.invoke() else onDenied()
    }

    return { action ->
        val wanted = buildList {
            if (
                ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) !=
                PackageManager.PERMISSION_GRANTED
            ) {
                add(Manifest.permission.RECORD_AUDIO)
            }
            if (
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) !=
                PackageManager.PERMISSION_GRANTED
            ) {
                add(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
        if (wanted.isEmpty()) {
            action()
        } else {
            pending[0] = action
            launcher.launch(wanted.toTypedArray())
        }
    }
}
