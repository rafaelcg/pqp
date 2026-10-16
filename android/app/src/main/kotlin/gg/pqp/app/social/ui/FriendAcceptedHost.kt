package gg.pqp.app.social.ui

import android.os.SystemClock
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.platform.LocalContext
import gg.pqp.app.R
import gg.pqp.app.social.FriendsDiff
import gg.pqp.app.social.PublicUser
import gg.pqp.app.social.SocialRepository

/**
 * "Tu e Bia agora são amigos" with "Mandar um oi", on the screen's own
 * snackbar host. Used by every screen that can be in front when a friendship
 * starts (Conversas, Friends), so it shows wherever the person is, once: the
 * offer is taken off the repository as soon as one of them has it.
 *
 * The button opens (or reuses) the conversation, which is [onSayHi]'s business.
 *
 * COLLECTED, NOT KEYED. Taking the offer changes the repository's state, and
 * an effect keyed on that state would be cancelled by its own `clear`, which
 * dismisses the snackbar the instant it appears. One long-lived collector
 * shows each offer for as long as the snackbar lasts.
 */
@Composable
fun FriendAcceptedEffect(
    social: SocialRepository,
    snackbars: SnackbarHostState,
    onSayHi: (PublicUser) -> Unit,
) {
    val context = LocalContext.current
    val sayHi by rememberUpdatedState(onSayHi)
    LaunchedEffect(social) {
        social.friendAccepted.collect { offer ->
            if (offer == null) return@collect
            // Taken now, so a second screen coming to the front does not offer it again.
            social.clearFriendAccepted()
            if (FriendsDiff.isStale(offer, SystemClock.elapsedRealtime())) return@collect
            // Another account's friendship is nobody else's news.
            if (!social.offerIsMine(offer)) return@collect
            val result = snackbars.showSnackbar(
                message = context.getString(R.string.friend_accepted_title, offer.person.displayName),
                actionLabel = context.getString(R.string.friend_accepted_cta),
                withDismissAction = true,
                duration = SnackbarDuration.Long,
            )
            if (result == SnackbarResult.ActionPerformed) sayHi(offer.person)
        }
    }
}
