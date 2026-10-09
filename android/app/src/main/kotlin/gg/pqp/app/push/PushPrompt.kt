package gg.pqp.app.push

import android.Manifest
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import gg.pqp.app.R

/**
 * The one-time "turn on notifications?" explainer, shown once after sign-in on
 * Android 13+ where POST_NOTIFICATIONS is a runtime permission.
 *
 * The system dialog is a one-shot resource (two refusals and Android stops
 * showing it at all), so it is spent only after a sentence of context, and only
 * on someone who tapped "Turn on". Any other way out, "Not now" or tapping
 * away, settles the question for good through [PushController.promptAnswered]:
 * the switch on the You screen is where a person who changes their mind goes,
 * the app does not ask again.
 */
@android.annotation.SuppressLint("InlinedApi")
@Composable
fun PushPrompt(push: PushController) {
    val needed by push.promptNeeded.collectAsStateWithLifecycle()

    val requestPermission = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        push.promptAnswered(granted)
    }

    if (!needed) return

    AlertDialog(
        onDismissRequest = { push.promptAnswered(false) },
        title = { Text(stringResource(R.string.push_prompt_title)) },
        text = { Text(stringResource(R.string.push_prompt_body)) },
        confirmButton = {
            TextButton(
                onClick = { requestPermission.launch(Manifest.permission.POST_NOTIFICATIONS) },
            ) {
                Text(stringResource(R.string.push_prompt_confirm))
            }
        },
        dismissButton = {
            TextButton(onClick = { push.promptAnswered(false) }) {
                Text(stringResource(R.string.push_prompt_dismiss))
            }
        },
    )
}
