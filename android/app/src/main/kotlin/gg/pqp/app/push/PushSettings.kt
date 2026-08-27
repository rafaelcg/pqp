package gg.pqp.app.push

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import gg.pqp.app.PqpApplication
import gg.pqp.app.R

/**
 * The one control this feature has: a switch on the You screen.
 *
 * Self-contained, and it reaches the controller through the Application rather
 * than through a parameter, so wiring it in is one line on a screen several
 * other features are also appending to.
 *
 * The switch is honest about the three ways it can be unavailable, because each
 * needs a different thing from a different person: no Firebase project in the
 * build (Rafael), no FCM leg on the server (Rafael), or a permission the user
 * refused (the user, in Android settings).
 */
@android.annotation.SuppressLint("InlinedApi")
@Composable
fun PushSettingsSection(modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val push = (context.applicationContext as? PqpApplication)?.push ?: return

    val state by push.state.collectAsStateWithLifecycle()
    val enabled by push.enabled.collectAsStateWithLifecycle()

    var permissionGranted by remember { mutableStateOf(hasNotificationPermission(context)) }
    var justRefused by remember { mutableStateOf(false) }

    // Somebody may have granted or revoked the permission in Android settings
    // while this app was in the background, and coming back is the only chance
    // to notice.
    LaunchedEffect(state) {
        permissionGranted = hasNotificationPermission(context)
    }

    val requestPermission = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        permissionGranted = granted
        justRefused = !granted
        // Only register once there is permission to draw something. A token
        // filed for an app that is not allowed to show a notification is a row
        // on the server that produces silence.
        if (granted) push.enable()
    }

    val configured = state !is PushState.Unavailable && state !is PushState.ServerUnsupported

    Column(modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(
                    text = stringResource(R.string.push_settings_title),
                    style = MaterialTheme.typography.titleMedium,
                )
                Text(
                    text = stringResource(R.string.push_settings_summary),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Spacer(Modifier.width(12.dp))
            Switch(
                checked = enabled && configured,
                enabled = configured,
                onCheckedChange = { wanted ->
                    if (!wanted) {
                        push.disable()
                        return@Switch
                    }
                    justRefused = false
                    if (permissionGranted) {
                        push.enable()
                    } else {
                        requestPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
                    }
                },
            )
        }

        val note = when {
            state is PushState.Unavailable -> stringResource(R.string.push_settings_unavailable)
            state is PushState.ServerUnsupported ->
                stringResource(R.string.push_settings_server_unsupported)
            state is PushState.Registering -> stringResource(R.string.push_settings_working)
            justRefused || (enabled && !permissionGranted) ->
                stringResource(R.string.push_settings_denied)
            state is PushState.Failed -> (state as PushState.Failed).reason
            else -> null
        }
        if (note != null) {
            Text(
                text = note,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

/**
 * POST_NOTIFICATIONS is a runtime permission from Android 13 (API 33). Below
 * that it does not exist and notifications are allowed by default, so asking
 * would put an unanswerable dialog on screen.
 *
 * `InlinedApi` is suppressed rather than worked around: the constant is a
 * compile-time String that inlines safely on every API level, and this function
 * returning true below 33 is what makes the request site above unreachable
 * there.
 */
@android.annotation.SuppressLint("InlinedApi")
private fun hasNotificationPermission(context: Context): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
    return ContextCompat.checkSelfPermission(
        context,
        Manifest.permission.POST_NOTIFICATIONS,
    ) == PackageManager.PERMISSION_GRANTED
}
