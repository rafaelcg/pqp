package gg.pqp.app.stories.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import gg.pqp.app.R
import gg.pqp.app.core.SessionStore
import gg.pqp.app.social.SocialRepository
import gg.pqp.app.stories.StoryAuthor
import gg.pqp.app.ui.theme.Palette
import gg.pqp.app.ui.theme.Spacing
import kotlinx.coroutines.launch

/**
 * What a tap on a mention opens: the person, with the two things worth doing
 * from a story, "Ver perfil" (their public page, when they have claimed a
 * handle) and "Adicionar amigo". Android has no profile screen for somebody
 * else yet; this is the smallest honest one.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun StoryProfileSheet(
    person: StoryAuthor,
    session: SessionStore,
    meId: String?,
    onDismiss: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val uri = LocalUriHandler.current
    var status by remember { mutableStateOf<String?>(null) }
    var failed by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    val sent = stringResource(R.string.stories_profile_request_sent)
    val accepted = stringResource(R.string.stories_profile_now_friends)

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        modifier = Modifier.testTag("stories.profile"),
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(Spacing.sm),
            modifier = Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .padding(horizontal = Spacing.gutter, vertical = Spacing.md),
        ) {
            AuthorAvatar(person, 72.dp)
            Text(person.displayName, style = MaterialTheme.typography.titleLarge, textAlign = TextAlign.Center)
            person.handle?.let {
                Text("@$it", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            status?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = if (failed) MaterialTheme.colorScheme.error else Palette.Success, modifier = Modifier.testTag("stories.profile.status"))
            }
            if (person.id != meId) {
                Button(
                    onClick = {
                        busy = true
                        scope.launch {
                            val result = SocialRepository.of(session).addFriend(person.id)
                            failed = result is SocialRepository.Outcome.Failed
                            status = when (result) {
                                SocialRepository.Outcome.Accepted -> accepted
                                SocialRepository.Outcome.RequestSent, SocialRepository.Outcome.Done -> sent
                                is SocialRepository.Outcome.Failed -> result.message
                            }
                            busy = false
                        }
                    },
                    // A failure leaves the button live: try again without closing the sheet.
                    enabled = !busy && (status == null || failed),
                    shape = MaterialTheme.shapes.small,
                    colors = ButtonDefaults.buttonColors(containerColor = Palette.Signal, contentColor = Palette.Ink),
                    modifier = Modifier.fillMaxWidth().padding(top = Spacing.sm).testTag("stories.profile.add"),
                ) { Text(stringResource(R.string.stories_profile_add_friend)) }
            }
            person.handle?.let { handle ->
                OutlinedButton(
                    onClick = { runCatching { uri.openUri("https://pqp.gg/@$handle") } },
                    shape = MaterialTheme.shapes.small,
                    modifier = Modifier.fillMaxWidth().testTag("stories.profile.view"),
                ) { Text(stringResource(R.string.stories_profile_view)) }
            }
        }
    }
}
