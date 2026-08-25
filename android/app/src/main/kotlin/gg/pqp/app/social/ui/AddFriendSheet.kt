package gg.pqp.app.social.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.PersonAdd
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

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .navigationBarsPadding(),
        ) {
            Text(
                text = stringResource(R.string.friends_add),
                style = MaterialTheme.typography.headlineSmall,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
            )
            PeopleSearchField(
                state = search,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
                tag = "friends.add.search",
            )
            PeopleSearchStatus(search, stringResource(R.string.friends_add_hint))

            LazyColumn(
                contentPadding = PaddingValues(bottom = 24.dp),
                modifier = Modifier.testTag("friends.add.results"),
            ) {
                items(search.results, key = { it.id }) { user ->
                    val outcome = results[user.id]
                    PersonRow(
                        user = user,
                        trailing = {
                            when {
                                busyId == user.id -> CircularProgressIndicator(Modifier.padding(8.dp).size(20.dp))
                                outcome != null -> Text(
                                    text = outcome,
                                    style = MaterialTheme.typography.labelMedium,
                                    color = MaterialTheme.colorScheme.primary,
                                )
                                // Somebody already in one of the three lists is
                                // not offered again: the server would answer 200
                                // and change nothing, which reads as a tap that
                                // did not work.
                                user.id in known -> Icon(
                                    Icons.Filled.Check,
                                    contentDescription = null,
                                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
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
                                    Icon(Icons.Filled.PersonAdd, contentDescription = null)
                                    Text(
                                        text = stringResource(R.string.friends_add_action),
                                        modifier = Modifier.padding(start = 8.dp),
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
