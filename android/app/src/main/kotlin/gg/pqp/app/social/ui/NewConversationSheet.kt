package gg.pqp.app.social.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.BottomSheetDefaults
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.InputChip
import androidx.compose.material3.InputChipDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import gg.pqp.app.R
import gg.pqp.app.social.DM_MAX_RECIPIENTS
import gg.pqp.app.social.DmSummary
import gg.pqp.app.social.PublicUser
import gg.pqp.app.social.SocialRepository
import gg.pqp.app.ui.components.SectionLabel
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Sizes
import gg.pqp.app.ui.theme.Spacing
import kotlinx.coroutines.launch

/**
 * Start a conversation.
 *
 * Friends are offered before anything is typed, because a friend is who you are
 * most likely to be messaging AND because the server already lets a friend
 * through a `server_members` DM privacy setting: they are the names least likely
 * to end in a refusal. It does not override `nobody`, so a refusal is still
 * possible and the server's own wording is what gets shown.
 *
 * Picking more than one person opens a group. The server caps a group at ten
 * people including you, so the picker stops at nine rather than letting somebody
 * assemble a room the API will reject.
 */
@OptIn(ExperimentalMaterial3Api::class, androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
fun NewConversationSheet(
    social: SocialRepository,
    onDismiss: () -> Unit,
    onOpened: (DmSummary) -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val search = rememberPeopleSearch()
    val friends by social.friends.collectAsStateWithLifecycle()
    val refusal by social.error.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()

    val selected = remember { mutableStateListOf<PublicUser>() }
    var opening by remember { mutableStateOf(false) }
    var limitHit by remember { mutableStateOf(false) }

    PeopleSearchEffect(search, social)

    // Online first, the order both other clients use, and the same list the
    // Friends tab draws from so the two never disagree about who exists.
    val suggestions = remember(friends) {
        friends.friends
            .sortedWith(
                compareBy<gg.pqp.app.social.Friend> { if (it.status == "offline") 1 else 0 }
                    .thenBy { it.displayName.lowercase() },
            )
            .map { it.asPublicUser() }
    }
    val rows = if (search.isTyping) search.results else suggestions

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        shape = pqpSheetShape(),
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
                text = stringResource(R.string.dms_new),
                style = MaterialTheme.typography.headlineMedium,
                color = MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.padding(horizontal = Spacing.gutter, vertical = Spacing.xs),
            )
            PeopleSearchField(
                state = search,
                modifier = Modifier.padding(horizontal = Spacing.gutter, vertical = Spacing.md),
                tag = "dms.new.search",
            )

            if (selected.isNotEmpty()) {
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(Spacing.sm),
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = Spacing.gutter),
                ) {
                    selected.forEach { user ->
                        InputChip(
                            selected = true,
                            onClick = { selected.remove(user) },
                            label = { Text(user.displayName) },
                            trailingIcon = {
                                Icon(
                                    imageVector = PqpIcons.Close,
                                    contentDescription = null,
                                    modifier = Modifier.size(InputChipDefaults.IconSize),
                                )
                            },
                            // A picked person is a fact, not an action: the
                            // reacting surface rather than the signal, so the
                            // one lime object on this sheet stays the button
                            // that opens the conversation.
                            colors = InputChipDefaults.inputChipColors(
                                selectedContainerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
                                selectedLabelColor = MaterialTheme.colorScheme.onSurface,
                                selectedTrailingIconColor = MaterialTheme.colorScheme.onSurfaceVariant,
                            ),
                            border = null,
                        )
                    }
                }
            }

            if (limitHit) {
                Text(
                    text = stringResource(R.string.dms_group_limit),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.padding(horizontal = Spacing.gutter, vertical = Spacing.sm),
                )
            }

            // Shown HERE rather than left to the snackbar on the screen behind:
            // this sheet covers that screen, so a refusal posted there is a
            // refusal nobody sees, and the tap reads as a button that does
            // nothing. The wording is the server's, verbatim: it answers every
            // refusal with the same sentence so that this box cannot become an
            // oracle for whether one specific person has blocked you.
            refusal?.takeIf { it.isNotBlank() }?.let { message ->
                Text(
                    text = message,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = Spacing.gutter, vertical = Spacing.sm)
                        .testTag("dms.new.error"),
                )
            }

            if (!search.isTyping && suggestions.isNotEmpty()) {
                SectionLabel(stringResource(R.string.friends_title))
            } else {
                PeopleSearchStatus(search, stringResource(R.string.dms_new_no_friends))
            }

            LazyColumn(
                contentPadding = PaddingValues(bottom = Spacing.sm),
                modifier = Modifier
                    .heightIn(max = 360.dp)
                    .testTag("dms.new.results"),
            ) {
                items(rows, key = { it.id }) { user ->
                    val isSelected = selected.any { it.id == user.id }
                    PersonRow(
                        user = user,
                        modifier = Modifier.clickable {
                            limitHit = false
                            social.clearError()
                            when {
                                isSelected -> selected.removeAll { it.id == user.id }
                                selected.size >= DM_MAX_RECIPIENTS -> limitHit = true
                                else -> selected.add(user)
                            }
                        },
                        trailing = {
                            if (isSelected) {
                                Icon(
                                    imageVector = PqpIcons.Confirm,
                                    contentDescription = null,
                                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                                    modifier = Modifier.size(Sizes.iconInline),
                                )
                            }
                        },
                    )
                }
            }

            if (selected.isNotEmpty()) {
                Button(
                    onClick = {
                        opening = true
                        social.clearError()
                        scope.launch {
                            val result = social.openConversation(selected.map { it.id })
                            opening = false
                            result.getOrNull()?.let {
                                onOpened(it)
                                onDismiss()
                            }
                            // A failure leaves the sheet open with the picks
                            // intact and the server's sentence above this
                            // button, so the tap that failed is next to the
                            // reason it failed.
                        }
                    },
                    enabled = !opening,
                    shape = MaterialTheme.shapes.small,
                    // The one lime object on the sheet, and the only thing on
                    // it that does anything irreversible.
                    colors = ButtonDefaults.buttonColors(
                        containerColor = MaterialTheme.colorScheme.primary,
                        contentColor = MaterialTheme.colorScheme.onPrimary,
                    ),
                    contentPadding = PaddingValues(vertical = Spacing.md, horizontal = Spacing.xl),
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(Spacing.gutter)
                        .testTag("dms.new.start"),
                ) {
                    if (opening) {
                        CircularProgressIndicator(
                            modifier = Modifier
                                .padding(end = Spacing.sm)
                                .size(Sizes.iconInline),
                            strokeWidth = 2.dp,
                            color = MaterialTheme.colorScheme.onPrimary,
                        )
                    }
                    Text(
                        text = if (selected.size == 1) {
                            stringResource(R.string.dms_new_start_one, selected[0].displayName)
                        } else {
                            stringResource(R.string.dms_new_start_group, selected.size + 1)
                        },
                        style = MaterialTheme.typography.labelLarge,
                    )
                }
            }
        }
    }
}
