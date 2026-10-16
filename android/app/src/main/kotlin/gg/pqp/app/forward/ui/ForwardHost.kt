package gg.pqp.app.forward.ui

import android.content.Intent
import android.net.Uri
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import gg.pqp.app.R
import gg.pqp.app.core.ApiClient
import gg.pqp.app.core.SessionStore
import gg.pqp.app.forward.ForwardConfigs
import gg.pqp.app.forward.ForwardDone
import gg.pqp.app.forward.ForwardInput
import gg.pqp.app.forward.ForwardLinks
import gg.pqp.app.forward.ForwardOpen
import gg.pqp.app.forward.ForwardSent
import gg.pqp.app.forward.MessageForward
import gg.pqp.app.ui.theme.Spacing

/** Starts the Encaminhar sheet for a source. Provided by [ForwardHost]; a no-op outside it. */
val LocalStartForward = staticCompositionLocalOf<(ForwardInput) -> Unit> { {} }

/**
 * Whether the Encaminhar action is offered right now (`GET /api/forwards/config`,
 * kept for a minute, off on any failure). Read at the screens that offer the
 * action; cards already in history draw regardless.
 */
@Composable
fun rememberForwardEnabled(api: ApiClient): Boolean {
    // Re-read every cache lifetime while the screen is composed: the flag is flipped
    // from a dashboard, and a failed first read must not leave the action hidden
    // until the screen is recreated. Between reads this is a cache hit.
    val enabled by produceState(false, api) {
        while (true) {
            value = ForwardConfigs.enabled(api)
            kotlinx.coroutines.delay(ForwardConfigs.TTL_MS)
        }
    }
    return enabled
}

/**
 * Owns the one Encaminhar sheet and its "Encaminhado" line for the whole
 * signed-in app, so a chat, a thread, a forum post and the Baú all start the
 * same flow with [LocalStartForward] and none of them carries picker state.
 *
 * [onView] is the "Ver" on the line: it opens the first place that took the
 * forward. Navigation stays the caller's, since only it knows the routes.
 */
@Composable
fun ForwardHost(
    session: SessionStore,
    onView: (ForwardSent) -> Unit,
    /** A line to say once (a card that cannot be opened), or null. */
    notice: String? = null,
    onNoticeShown: () -> Unit = {},
    content: @Composable () -> Unit,
) {
    var forwarding by remember { mutableStateOf<ForwardInput?>(null) }
    var announce by remember { mutableStateOf<ForwardDone?>(null) }
    val snackbars = remember { SnackbarHostState() }
    val start = remember { { input: ForwardInput -> forwarding = input } }

    CompositionLocalProvider(LocalStartForward provides start) {
        Box(Modifier.fillMaxSize()) {
            content()

            forwarding?.let { input ->
                ForwardSheet(
                    session = session,
                    input = input,
                    onDismiss = { forwarding = null },
                    onDone = { announce = it },
                )
            }

            SnackbarHost(
                hostState = snackbars,
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .navigationBarsPadding()
                    .padding(horizontal = Spacing.md, vertical = Spacing.md),
            )
        }
    }

    // A tap on a card this account cannot open. Shown on the same line as the
    // "Encaminhado" confirmation, one at a time, and consumed so it never repeats.
    LaunchedEffect(notice) {
        if (notice != null) {
            snackbars.showSnackbar(message = notice, duration = SnackbarDuration.Short)
            onNoticeShown()
        }
    }

    announce?.let { done ->
        val message = forwardSentMessage(done)
        val view = stringResource(R.string.forward_view)
        LaunchedEffect(done) {
            val result = snackbars.showSnackbar(
                message = message,
                actionLabel = view,
                duration = SnackbarDuration.Long,
            )
            announce = null
            if (result == SnackbarResult.ActionPerformed) onView(done.sent.first())
        }
    }
}

/**
 * Opens what a forward card points at: a Baú post or a message inside the app,
 * anything else in a Custom Tab. [open] is what the caller does for an in-app
 * target (a navigation); a browser URL is handled here.
 */
@Composable
fun rememberOpenForward(open: (ForwardOpen) -> Unit): (MessageForward) -> Unit {
    val context = LocalContext.current
    return remember(context, open) {
        { forward: MessageForward ->
            when (val target = ForwardLinks.resolve(forward)) {
                is ForwardOpen.External -> openInBrowser(context, target.url)
                else -> open(target)
            }
        }
    }
}

/** A Custom Tab for an `http(s)` URL; an app with no browser, or any other scheme, does nothing. */
fun openInBrowser(context: android.content.Context, url: String) {
    if (!ForwardLinks.isBrowsable(url)) return
    val uri = Uri.parse(url.trim())
    try {
        CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(context, uri)
    } catch (_: Exception) {
        try {
            context.startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: Exception) {
            // No browser at all: nothing to open, and nothing to crash over.
        }
    }
}
