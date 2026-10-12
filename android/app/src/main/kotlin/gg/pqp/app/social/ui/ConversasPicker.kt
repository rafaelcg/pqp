package gg.pqp.app.social.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.BottomSheetDefaults
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import gg.pqp.app.R
import gg.pqp.app.social.DM_MAX_RECIPIENTS
import gg.pqp.app.social.Friend
import gg.pqp.app.social.FriendsResponse
import gg.pqp.app.social.PublicUser
import gg.pqp.app.social.SocialRepository
import gg.pqp.app.ui.components.SectionLabel
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Sizes
import gg.pqp.app.ui.theme.Spacing

/**
 * Nova conversa, the Conversas way (the web's W3): nobody types to message a
 * friend. Online agora, then Amigos, each with presence. A name with nothing
 * ticked opens the conversation; the box beside it builds a group instead.
 * The search still finds anybody by name or `nome#0000`.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ConversasPicker(
    social: SocialRepository,
    search: PeopleSearchState,
    friends: FriendsResponse,
    refusal: String?,
    selected: SnapshotStateList<PublicUser>,
    opening: Boolean,
    limitHit: Boolean,
    onLimitHit: (Boolean) -> Unit,
    onOpen: (List<PublicUser>) -> Unit,
    onAddFriend: (() -> Unit)?,
    onDismiss: () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    PeopleSearchEffect(search, social)

    val sorted = remember(friends) { friends.friends.sortedBy { it.displayName.lowercase() } }
    val online = sorted.filter { it.status != "offline" }
    val offline = sorted.filter { it.status == "offline" }
    val statusById = remember(friends) { friends.friends.associate { it.id to it.status } }

    val toggle: (PublicUser) -> Unit = { user ->
        onLimitHit(false)
        social.clearError()
        when {
            selected.any { it.id == user.id } -> selected.removeAll { it.id == user.id }
            selected.size >= DM_MAX_RECIPIENTS -> onLimitHit(true)
            else -> selected.add(user)
        }
    }
    val tap: (PublicUser) -> Unit = { user ->
        if (selected.isEmpty()) {
            if (!opening) onOpen(listOf(user))
        } else {
            toggle(user)
        }
    }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        shape = pqpSheetShape(),
        containerColor = MaterialTheme.colorScheme.surfaceContainer,
        dragHandle = {
            BottomSheetDefaults.DragHandle(color = MaterialTheme.colorScheme.onSurfaceVariant)
        },
        modifier = Modifier.testTag("conversas.new"),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .navigationBarsPadding(),
        ) {
            Text(
                text = stringResource(R.string.conversas_new),
                style = MaterialTheme.typography.headlineMedium,
                color = MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.padding(horizontal = Spacing.gutter, vertical = Spacing.xs),
            )
            Text(
                text = stringResource(R.string.conversas_new_description, DM_MAX_RECIPIENTS),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = Spacing.gutter),
            )
            PeopleSearchField(
                state = search,
                modifier = Modifier.padding(horizontal = Spacing.gutter, vertical = Spacing.md),
                tag = "dms.new.search",
            )

            if (limitHit) {
                Text(
                    text = stringResource(R.string.dms_group_limit),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.padding(horizontal = Spacing.gutter, vertical = Spacing.sm),
                )
            }
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

            LazyColumn(
                contentPadding = PaddingValues(bottom = Spacing.sm),
                modifier = Modifier
                    .heightIn(max = 440.dp)
                    .testTag("dms.new.results"),
            ) {
                if (search.isTyping) {
                    item(key = "status") {
                        PeopleSearchStatus(search, stringResource(R.string.conversas_new_no_friends))
                    }
                    items(search.results, key = { "s-" + it.id }) { user ->
                        PickRow(user, statusById[user.id], selected, onTap = tap, onTick = toggle)
                    }
                } else {
                    if (onAddFriend != null) {
                        item(key = "add") {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable(onClick = onAddFriend)
                                    .padding(horizontal = Spacing.gutter, vertical = Spacing.sm)
                                    .testTag("conversas.new.addFriend"),
                            ) {
                                Box(
                                    contentAlignment = Alignment.Center,
                                    modifier = Modifier
                                        .size(Sizes.avatarPerson)
                                        .clip(CircleShape)
                                        .background(MaterialTheme.colorScheme.surfaceContainerHighest),
                                ) {
                                    Icon(
                                        PqpIcons.AddFriend,
                                        contentDescription = null,
                                        tint = MaterialTheme.colorScheme.onSurface,
                                        modifier = Modifier.size(Sizes.iconInline),
                                    )
                                }
                                Spacer(Modifier.width(Spacing.md))
                                Text(
                                    text = stringResource(R.string.friends_add),
                                    style = MaterialTheme.typography.titleSmall,
                                    color = MaterialTheme.colorScheme.onSurface,
                                )
                            }
                        }
                    }
                    if (sorted.isEmpty()) {
                        item(key = "none") {
                            Text(
                                text = stringResource(R.string.conversas_new_no_friends),
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(Spacing.gutter),
                            )
                        }
                    }
                    if (online.isNotEmpty()) {
                        item(key = "h-online") { SectionLabel(stringResource(R.string.conversas_new_online)) }
                        items(online, key = { "o-" + it.id }) { friend ->
                            PickRow(friend.asPublicUser(), friend.status, selected, onTap = tap, onTick = toggle)
                        }
                    }
                    if (offline.isNotEmpty()) {
                        item(key = "h-friends") { SectionLabel(stringResource(R.string.conversas_new_friends)) }
                        items(offline, key = { "f-" + it.id }) { friend: Friend ->
                            PickRow(friend.asPublicUser(), friend.status, selected, onTap = tap, onTick = toggle)
                        }
                    }
                }
            }

            if (selected.isNotEmpty()) {
                Button(
                    onClick = { onOpen(selected.toList()) },
                    enabled = !opening,
                    shape = MaterialTheme.shapes.small,
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

@Composable
private fun PickRow(
    user: PublicUser,
    status: String?,
    selected: List<PublicUser>,
    onTap: (PublicUser) -> Unit,
    onTick: (PublicUser) -> Unit,
) {
    val ticked = selected.any { it.id == user.id }
    val tickLabel = stringResource(R.string.conversas_new_tick, user.displayName)
    PersonRow(
        user = user,
        status = status,
        subtitle = user.username?.let { "@$it" } ?: user.tag,
        modifier = Modifier
            .clickable { onTap(user) }
            .testTag("conversas.new.person"),
        trailing = {
            Checkbox(
                checked = ticked,
                onCheckedChange = { onTick(user) },
                colors = CheckboxDefaults.colors(
                    checkedColor = MaterialTheme.colorScheme.primary,
                    checkmarkColor = MaterialTheme.colorScheme.onPrimary,
                    uncheckedColor = MaterialTheme.colorScheme.outline,
                ),
                modifier = Modifier
                    .semantics { contentDescription = tickLabel }
                    .testTag("conversas.new.tick"),
            )
        },
    )
}
