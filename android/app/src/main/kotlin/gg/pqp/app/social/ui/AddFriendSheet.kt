package gg.pqp.app.social.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.BottomSheetDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import gg.pqp.app.R
import gg.pqp.app.social.SocialRepository
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Sizes
import gg.pqp.app.ui.theme.Spacing
import kotlinx.coroutines.launch

/**
 * Add a friend, by handle.
 *
 * The outcome is spelled out in the row itself rather than in a toast that
 * disappears, because the protocol offers no other feedback: the other side is
 * never notified in a way this client can see, and there is no frame back.
 * "Request sent" and "You are now friends" are two genuinely different results
 * of the same tap (the second means they had already asked you), and a person
 * who cannot tell them apart does not know whether to wait.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AddFriendSheet(
    social: SocialRepository,
    known: Set<String>,
    onDismiss: () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val search = rememberPeopleSearch()
    val scope = rememberCoroutineScope()

    var busyId by remember { mutableStateOf<String?>(null) }
    var results by remember { mutableStateOf<Map<String, String>>(emptyMap()) }

    PeopleSearchEffect(search, social)

    val requestSent = stringResource(R.string.friends_request_sent)
    val nowFriends = stringResource(R.string.friends_now_friends)

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        shape = pqpSheetShape(),
        // A sheet is a thing that lifts, so it sits one step up the ramp from
        // the page it covers rather than on the same colour as it.
        containerColor = MaterialTheme.colorScheme.surfaceContainer,
        dragHandle = {
            BottomSheetDefaults.DragHandle(color = MaterialTheme.colorScheme.onSurfaceVariant)
        },
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .navigationBarsPadding(),
        ) {
            Text(
                text = stringResource(R.string.friends_add),
                style = MaterialTheme.typography.headlineMedium,
                color = MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.padding(horizontal = Spacing.gutter, vertical = Spacing.xs),
            )
            PeopleSearchField(
                state = search,
                modifier = Modifier.padding(horizontal = Spacing.gutter, vertical = Spacing.md),
                tag = "friends.add.search",
            )
            PeopleSearchStatus(search, stringResource(R.string.friends_add_hint))

            LazyColumn(
                contentPadding = PaddingValues(bottom = Spacing.xl),
                modifier = Modifier.testTag("friends.add.results"),
            ) {
                items(search.results, key = { it.id }) { user ->
                    val outcome = results[user.id]
                    PersonRow(
                        user = user,
                        trailing = {
                            when {
                                busyId == user.id -> CircularProgressIndicator(
                                    modifier = Modifier
                                        .padding(Spacing.sm)
                                        .size(Sizes.iconInline),
                                    strokeWidth = 2.dp,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                                // The result of the tap, in the row that was
                                // tapped. Muted rather than lime: it is a
                                // record of something that already happened,
                                // and the signal colour means "act on this".
                                outcome != null -> Text(
                                    text = outcome,
                                    style = MaterialTheme.typography.labelMedium,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                                // Somebody already in one of the three lists is
                                // not offered again: the server would answer 200
                                // and change nothing, which reads as a tap that
                                // did not work.
                                user.id in known -> Icon(
                                    imageVector = PqpIcons.Confirm,
                                    contentDescription = null,
                                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                                    modifier = Modifier.size(Sizes.iconInline),
                                )
                                // Tonal, not lime. There is one of these per
                                // result row and a column of lime buttons is a
                                // column of things all shouting at once.
                                else -> FilledTonalButton(
                                    onClick = {
                                        busyId = user.id
                                        scope.launch {
                                            val result = social.addFriend(user.id)
                                            busyId = null
                                            results = results + (
                                                user.id to when (result) {
                                                    SocialRepository.Outcome.Accepted -> nowFriends
                                                    SocialRepository.Outcome.RequestSent -> requestSent
                                                    // The server's own sentence,
                                                    // never a friendlier one: one
                                                    // wording for every refusal is
                                                    // what stops this being an
                                                    // oracle for who blocked whom.
                                                    is SocialRepository.Outcome.Failed -> result.message
                                                    SocialRepository.Outcome.Done -> requestSent
                                                }
                                                )
                                        }
                                    },
                                ) {
                                    Icon(
                                        imageVector = PqpIcons.AddFriend,
                                        contentDescription = null,
                                        modifier = Modifier.size(Sizes.iconInline),
                                    )
                                    Text(
                                        text = stringResource(R.string.friends_add_action),
                                        modifier = Modifier.padding(start = Spacing.sm),
                                    )
                                }
                            }
                        },
                    )
                }
            }
        }
    }
}
