package gg.pqp.app.follow.ui

import androidx.annotation.StringRes
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandHorizontally
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkHorizontally
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuAnchorType
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import gg.pqp.app.R
import gg.pqp.app.core.SessionStore
import gg.pqp.app.follow.BauFollow
import gg.pqp.app.follow.BauFollowState
import gg.pqp.app.follow.BauFollowViewModel
import gg.pqp.app.follow.BauFollower
import gg.pqp.app.follow.BauFollowersViewModel
import gg.pqp.app.follow.ChannelFollowsViewModel
import gg.pqp.app.follow.FollowFailure
import gg.pqp.app.follow.FollowPermissions
import gg.pqp.app.follow.PickerLoadError
import gg.pqp.app.ui.components.Avatar
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Sizes
import gg.pqp.app.ui.theme.Spacing

/*
 * Seguir on the phone: the button on the Baú's header, the sheet that sets a
 * follow up, the staff's follower list with "Permitir seguir", and "Seguindo" on
 * a channel. The web's counterparts are `bau-follow.tsx`,
 * `channel-bau-follows-section.tsx` and the Baú settings section.
 */

@StringRes
internal fun followFailureText(failure: FollowFailure): Int = when (failure) {
    FollowFailure.Slow -> R.string.follow_error_slow
    FollowFailure.Forbidden -> R.string.follow_error_forbidden
    FollowFailure.Blocked -> R.string.follow_error_blocked
    FollowFailure.Limit -> R.string.follow_error_limit
    FollowFailure.Exists -> R.string.follow_error_exists
    FollowFailure.Invalid -> R.string.follow_error_invalid
    FollowFailure.Unavailable -> R.string.follow_unavailable
    FollowFailure.Action -> R.string.follow_error_action
    FollowFailure.Generic -> R.string.follow_error_generic
}

/** "Seguir" on the Baú header, or "Seguindo" once the viewer follows it somewhere. Absent when not followable. */
@Composable
fun FollowButton(state: BauFollowState?, onOpen: () -> Unit) {
    if (state?.enabled != true) return
    val following = state.mine.isNotEmpty()
    val description = stringResource(R.string.follow_button_description)
    TextButton(
        onClick = onOpen,
        modifier = Modifier
            .testTag("bau.follow.open")
            .semantics { contentDescription = description },
    ) {
        Icon(
            imageVector = if (following) PqpIcons.Following else PqpIcons.Follow,
            contentDescription = null,
            modifier = Modifier.size(Sizes.iconInline),
        )
        Spacer(Modifier.width(Spacing.sm))
        Text(stringResource(if (following) R.string.follow_button_active else R.string.follow_button))
    }
}

/** Pick a server of yours, a channel there, optionally a role to mention, and follow. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BauFollowSheet(model: BauFollowViewModel, serverName: String) {
    val open by model.pickerOpen.collectAsStateWithLifecycle()
    if (!open) return
    val picker by model.picker.collectAsStateWithLifecycle()
    val state by model.state.collectAsStateWithLifecycle()
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    ModalBottomSheet(
        onDismissRequest = model::closePicker,
        sheetState = sheetState,
        modifier = Modifier.testTag("bau.follow.sheet"),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .navigationBarsPadding()
                .padding(horizontal = Spacing.gutter)
                .padding(bottom = Spacing.lg),
            verticalArrangement = Arrangement.spacedBy(Spacing.lg),
        ) {
            Column {
                Text(
                    text = serverName,
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(stringResource(R.string.follow_title), style = MaterialTheme.typography.titleLarge)
                Spacer(Modifier.size(Spacing.xs))
                Text(
                    text = stringResource(R.string.follow_hint),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            val mine = state?.mine.orEmpty()
            if (mine.isNotEmpty()) {
                Column(verticalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                    SectionLabel(stringResource(R.string.follow_yours))
                    mine.forEach { follow ->
                        FollowRow(
                            follow = follow,
                            primary = follow.targetServerName,
                            busy = picker.rowBusy != null,
                            onResume = { model.resume(follow) },
                            onUnfollow = { model.unfollow(follow) },
                            tag = "bau.follow.row",
                        )
                    }
                }
            }

            when {
                picker.loadError == PickerLoadError.Failed -> Column(verticalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                    Text(
                        text = stringResource(R.string.follow_load_failed),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.error,
                        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                    )
                    OutlinedButton(onClick = model::retryLoad) { Text(stringResource(R.string.follow_retry)) }
                }

                picker.loadError == PickerLoadError.Off -> Text(
                    text = stringResource(R.string.follow_unavailable),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.testTag("bau.follow.off"),
                )

                picker.destinations == null -> CircularProgressIndicator(
                    modifier = Modifier.align(Alignment.CenterHorizontally).testTag("bau.follow.loading"),
                )

                picker.destinations?.isEmpty() == true -> Text(
                    text = stringResource(R.string.follow_no_destinations),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.testTag("bau.follow.empty"),
                )

                else -> PickerForm(model, picker)
            }

            picker.notice?.let { notice ->
                Text(
                    text = stringResource(R.string.follow_followed, notice.channelName, notice.serverName),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(MaterialTheme.shapes.small)
                        .background(MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.4f))
                        .padding(Spacing.md)
                        .semantics { liveRegion = LiveRegionMode.Polite }
                        .testTag("bau.follow.notice"),
                )
            }
            picker.error?.let { failure ->
                Text(
                    text = stringResource(followFailureText(failure)),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier
                        .semantics { liveRegion = LiveRegionMode.Assertive }
                        .testTag("bau.follow.error"),
                )
            }

            Row(horizontalArrangement = Arrangement.spacedBy(Spacing.sm), modifier = Modifier.align(Alignment.End)) {
                TextButton(onClick = model::closePicker, enabled = !picker.busy) {
                    Text(stringResource(R.string.follow_close))
                }
                if (picker.destinations?.isNotEmpty() == true) {
                    Button(
                        onClick = model::submit,
                        enabled = picker.canSubmit,
                        modifier = Modifier.testTag("bau.follow.submit"),
                    ) {
                        Text(stringResource(if (picker.busy) R.string.follow_submitting else R.string.follow_submit))
                    }
                }
            }
        }
    }
}

@Composable
private fun PickerForm(model: BauFollowViewModel, picker: gg.pqp.app.follow.FollowPickerState) {
    val destinations = picker.destinations.orEmpty()
    val destination = picker.destination
    Column(verticalArrangement = Arrangement.spacedBy(Spacing.md)) {
        SelectField(
            label = stringResource(R.string.follow_server),
            value = destination?.serverName.orEmpty(),
            options = destinations.map { it.serverId to it.serverName },
            enabled = !picker.busy,
            onPick = model::pickDestination,
            tag = "bau.follow.server",
        )
        if (picker.full) {
            Text(
                text = stringResource(
                    R.string.follow_destination_full,
                    destination?.serverName.orEmpty(),
                    picker.maxPerServer,
                ),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.tertiary,
                modifier = Modifier.testTag("bau.follow.full"),
            )
        } else if (picker.freeChannels.isEmpty()) {
            Text(
                text = stringResource(R.string.follow_all_followed),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.testTag("bau.follow.allFollowed"),
            )
        } else {
            SelectField(
                label = stringResource(R.string.follow_channel),
                value = picker.freeChannels.firstOrNull { it.id == picker.channelId }?.name?.let { "# $it" }.orEmpty(),
                options = picker.freeChannels.map { it.id to "# ${it.name}" },
                enabled = !picker.busy,
                onPick = model::pickChannel,
                tag = "bau.follow.channel",
            )
            if (destination != null && destination.roles.isNotEmpty()) {
                val none = stringResource(R.string.follow_no_role)
                SelectField(
                    label = stringResource(R.string.follow_role),
                    value = destination.roles.firstOrNull { it.id == picker.roleId }?.let { "@${it.name}" } ?: none,
                    options = listOf("" to none) + destination.roles.map { it.id to "@${it.name}" },
                    enabled = !picker.busy,
                    onPick = model::pickRole,
                    tag = "bau.follow.role",
                )
            }
        }
    }
}

/** A read-only field that opens a menu: the phone's `<select>`. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SelectField(
    label: String,
    value: String,
    options: List<Pair<String, String>>,
    enabled: Boolean,
    onPick: (String) -> Unit,
    tag: String,
) {
    var expanded by remember { mutableStateOf(false) }
    ExposedDropdownMenuBox(
        expanded = expanded,
        onExpandedChange = { if (enabled) expanded = it },
    ) {
        OutlinedTextField(
            value = value,
            onValueChange = {},
            readOnly = true,
            singleLine = true,
            enabled = enabled,
            label = { Text(label) },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
            shape = MaterialTheme.shapes.small,
            modifier = Modifier
                .fillMaxWidth()
                .menuAnchor(ExposedDropdownMenuAnchorType.PrimaryNotEditable)
                .testTag(tag),
        )
        ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            options.forEach { (id, name) ->
                DropdownMenuItem(
                    text = { Text(name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    onClick = {
                        expanded = false
                        onPick(id)
                    },
                    contentPadding = ExposedDropdownMenuDefaults.ItemContentPadding,
                    modifier = Modifier.testTag("$tag.option"),
                )
            }
        }
    }
}

@Composable
private fun SectionLabel(text: String) {
    Text(
        text = text,
        style = MaterialTheme.typography.labelMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

/** One follow, as the follower (the person) sees it: where it lands, who it pings, whether it is paused. */
@Composable
private fun FollowRow(
    follow: BauFollow,
    primary: String,
    busy: Boolean,
    onResume: () -> Unit,
    onUnfollow: () -> Unit,
    tag: String,
    /** The channel's list is about the SOURCE, so it shows its icon and name. */
    iconUrl: String? = null,
    secondary: String = "# ${follow.targetChannelName}",
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.small)
            .background(MaterialTheme.colorScheme.surfaceContainer)
            .border(Sizes.hairline, MaterialTheme.colorScheme.outline, MaterialTheme.shapes.small)
            .padding(Spacing.md)
            .testTag(tag),
        verticalArrangement = Arrangement.spacedBy(Spacing.sm),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.md)) {
            Avatar(name = primary, url = iconUrl, size = Sizes.avatarRow, cornerRadius = 8.dp)
            Column(Modifier.weight(1f)) {
                Text(
                    text = primary,
                    style = MaterialTheme.typography.bodyLarge,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (secondary.isNotBlank()) {
                    Text(
                        text = secondary,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                follow.rolePingName?.let {
                    Text(
                        text = stringResource(R.string.follow_pings, it),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            if (follow.isPaused) {
                Text(
                    text = stringResource(R.string.follow_paused),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.tertiary,
                    modifier = Modifier.testTag("$tag.paused"),
                )
            }
        }
        if (follow.isPaused) {
            Text(
                text = stringResource(
                    if (follow.pausedBecauseBanned) R.string.follow_paused_hint_banned else R.string.follow_paused_hint,
                ),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.tertiary,
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(Spacing.sm), modifier = Modifier.align(Alignment.End)) {
            if (follow.isPaused) {
                OutlinedButton(onClick = onResume, enabled = !busy, modifier = Modifier.testTag("$tag.resume")) {
                    Text(stringResource(R.string.follow_resume))
                }
            }
            TextButton(onClick = onUnfollow, enabled = !busy, modifier = Modifier.testTag("$tag.unfollow")) {
                Text(stringResource(R.string.follow_unfollow), color = MaterialTheme.colorScheme.error)
            }
        }
    }
}

// ----------------------------------------------------------- the source's staff

/**
 * Staff of the source Baú: the owner's switch "Permitir seguir", who follows
 * (server names, never people), remove one, or remove and block its server, and
 * unblock.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BauFollowersSheet(
    session: SessionStore,
    serverId: String,
    onChanged: () -> Unit,
    onDismiss: () -> Unit,
) {
    val model: BauFollowersViewModel = viewModel(
        key = "bau-followers-$serverId",
        factory = BauFollowersViewModel.factory(session, serverId, onChanged),
    )
    val state by model.state.collectAsStateWithLifecycle()
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        modifier = Modifier.testTag("bau.followers.sheet"),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .navigationBarsPadding()
                .padding(horizontal = Spacing.gutter)
                .padding(bottom = Spacing.lg),
            verticalArrangement = Arrangement.spacedBy(Spacing.lg),
        ) {
            Column {
                Text(stringResource(R.string.follow_followers_title), style = MaterialTheme.typography.titleLarge)
                Spacer(Modifier.size(Spacing.xs))
                Text(
                    text = stringResource(R.string.follow_followers_hint),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            val data = state.data
            if (state.loadFailed) {
                Column(verticalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                    Text(
                        text = stringResource(R.string.follow_followers_load_failed),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.error,
                        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                    )
                    OutlinedButton(onClick = model::load) { Text(stringResource(R.string.follow_retry)) }
                }
            }
            if (data == null && !state.loadFailed) {
                CircularProgressIndicator(modifier = Modifier.align(Alignment.CenterHorizontally))
            }
            if (data != null) {
                if (data.flagOn) {
                    AllowSwitch(
                        allowed = data.allowed,
                        busy = state.busyKey != null,
                        onChange = model::setAllowed,
                    )
                }
                Text(
                    text = pluralStringResource(R.plurals.follow_followers_count, data.count, data.count),
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.testTag("bau.followers.count"),
                )
                if (data.followers.isEmpty()) {
                    Text(
                        text = stringResource(R.string.follow_followers_empty),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                } else {
                    data.followers.take(state.shown).forEach { follower ->
                        FollowerRow(
                            follower = follower,
                            busy = state.busyKey != null,
                            onRemove = { model.remove(follower) },
                            onBlock = { model.askBlock(follower) },
                        )
                    }
                    if (data.followers.size > state.shown || data.nextCursor != null) {
                        OutlinedButton(
                            onClick = model::showMore,
                            enabled = !state.loadingMore,
                            modifier = Modifier.testTag("bau.followers.more"),
                        ) {
                            Text(stringResource(R.string.follow_followers_more))
                        }
                    }
                }
                if (data.blocked.isNotEmpty()) {
                    Column(verticalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                        SectionLabel(stringResource(R.string.follow_followers_blocked))
                        data.blocked.forEach { blocked ->
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clip(MaterialTheme.shapes.small)
                                    .background(MaterialTheme.colorScheme.surfaceContainer)
                                    .padding(start = Spacing.md)
                                    .testTag("bau.followers.blockedRow"),
                            ) {
                                Text(
                                    text = blocked.serverName,
                                    style = MaterialTheme.typography.bodyLarge,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.weight(1f),
                                )
                                TextButton(
                                    onClick = { model.unblock(blocked) },
                                    enabled = state.busyKey == null,
                                    modifier = Modifier.testTag("bau.followers.unblock"),
                                ) { Text(stringResource(R.string.follow_followers_unblock)) }
                            }
                        }
                    }
                }
            }
            state.error?.let { failure ->
                Text(
                    text = stringResource(followFailureText(failure)),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.semantics { liveRegion = LiveRegionMode.Assertive },
                )
            }
            TextButton(onClick = onDismiss, modifier = Modifier.align(Alignment.End)) {
                Text(stringResource(R.string.follow_close))
            }
        }
    }

    state.confirmBlock?.let { target ->
        AlertDialog(
            onDismissRequest = model::cancelBlock,
            title = { Text(stringResource(R.string.follow_followers_confirm_block_title, target.targetServerName)) },
            text = { Text(stringResource(R.string.follow_followers_confirm_block_body)) },
            confirmButton = {
                TextButton(onClick = model::confirmBlock, modifier = Modifier.testTag("bau.followers.confirmBlock")) {
                    Text(stringResource(R.string.follow_followers_block), color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = {
                TextButton(onClick = model::cancelBlock) { Text(stringResource(R.string.cancel)) }
            },
        )
    }
}

/** "Permitir seguir": the owner's own switch, default off. */
@Composable
private fun AllowSwitch(allowed: Boolean, busy: Boolean, onChange: (Boolean) -> Unit) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .toggleable(
                value = allowed,
                enabled = !busy,
                role = Role.Switch,
                onValueChange = onChange,
            )
            .testTag("bau.follow.allow"),
    ) {
        Column(Modifier.weight(1f)) {
            Text(stringResource(R.string.follow_allow_title), style = MaterialTheme.typography.titleMedium)
            Text(
                text = stringResource(R.string.follow_allow_helper),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Spacer(Modifier.width(Spacing.md))
        // The row is the control; the switch only draws its state.
        Switch(checked = allowed, onCheckedChange = null, enabled = !busy)
    }
}

@Composable
private fun FollowerRow(follower: BauFollower, busy: Boolean, onRemove: () -> Unit, onBlock: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.small)
            .background(MaterialTheme.colorScheme.surfaceContainer)
            .border(Sizes.hairline, MaterialTheme.colorScheme.outline, MaterialTheme.shapes.small)
            .padding(Spacing.md)
            .testTag("bau.followers.row"),
        verticalArrangement = Arrangement.spacedBy(Spacing.sm),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.md)) {
            Avatar(
                name = follower.targetServerName,
                url = follower.targetServerIconUrl,
                size = Sizes.avatarRow,
                cornerRadius = 8.dp,
            )
            Column(Modifier.weight(1f)) {
                Text(
                    text = follower.targetServerName,
                    style = MaterialTheme.typography.bodyLarge,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    text = "# ${follower.targetChannelName}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (follower.isPaused) {
                Text(
                    text = stringResource(R.string.follow_paused),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.tertiary,
                )
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(Spacing.sm), modifier = Modifier.align(Alignment.End)) {
            TextButton(onClick = onRemove, enabled = !busy, modifier = Modifier.testTag("bau.followers.remove")) {
                Text(stringResource(R.string.follow_followers_remove))
            }
            TextButton(onClick = onBlock, enabled = !busy, modifier = Modifier.testTag("bau.followers.block")) {
                Text(stringResource(R.string.follow_followers_block), color = MaterialTheme.colorScheme.error)
            }
        }
    }
}

// ------------------------------------------------------------------ a channel

/**
 * "Seguindo" in a text channel's header: the Baús this channel follows, each
 * with Deixar de seguir, and Retomar when the follow paused itself.
 *
 * Drawn only for somebody who may manage the channel AND only when the channel
 * follows something (or the read failed, so a hiccup does not hide the way to
 * unfollow). A deployment where Seguir is off, and every ordinary member, never
 * see it, and members never even ask: the permission check comes first.
 */
@Composable
fun ChannelFollowsAction(session: SessionStore, serverId: String, channelId: String) {
    val allowed by produceState(initialValue = false, serverId, channelId) {
        value = FollowPermissions.mayManage(session.api, serverId, channelId)
    }
    if (!allowed) return
    val model: ChannelFollowsViewModel = viewModel(
        key = "channel-follows-$channelId",
        factory = ChannelFollowsViewModel.factory(session, channelId),
    )
    val state by model.state.collectAsStateWithLifecycle()
    var open by remember { mutableStateOf(false) }
    AnimatedVisibility(
        visible = state.visible,
        enter = fadeIn() + expandHorizontally(expandFrom = Alignment.Start),
        exit = fadeOut() + shrinkHorizontally(shrinkTowards = Alignment.Start),
    ) {
        IconButton(
            onClick = {
                // A follow can pause itself while the channel is open: read again
                // so the sheet says what is true now.
                model.load()
                open = true
            },
            modifier = Modifier.testTag("chat.follows"),
        ) {
            Icon(
                imageVector = PqpIcons.Following,
                contentDescription = stringResource(R.string.follow_channel_action),
                modifier = Modifier.size(Sizes.iconAction),
            )
        }
    }
    if (open && state.visible) {
        ChannelFollowsSheet(model = model, onDismiss = { open = false })
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChannelFollowsSheet(model: ChannelFollowsViewModel, onDismiss: () -> Unit) {
    val state by model.state.collectAsStateWithLifecycle()
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        modifier = Modifier.testTag("chat.follows.sheet"),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(max = 640.dp)
                .verticalScroll(rememberScrollState())
                .navigationBarsPadding()
                .padding(horizontal = Spacing.gutter)
                .padding(bottom = Spacing.lg),
            verticalArrangement = Arrangement.spacedBy(Spacing.md),
        ) {
            Text(stringResource(R.string.follow_channel_title), style = MaterialTheme.typography.titleLarge)
            Text(
                text = stringResource(R.string.follow_channel_description),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (state.failed) {
                Column(verticalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                    Text(
                        text = stringResource(R.string.follow_channel_load_failed),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.error,
                        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                    )
                    OutlinedButton(onClick = model::load) { Text(stringResource(R.string.follow_retry)) }
                }
            }
            state.error?.let { failure ->
                Text(
                    text = stringResource(followFailureText(failure)),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.semantics { liveRegion = LiveRegionMode.Assertive },
                )
            }
            state.follows.forEach { follow ->
                FollowRow(
                    follow = follow,
                    primary = stringResource(R.string.follow_channel_from, follow.sourceServerName),
                    secondary = "",
                    iconUrl = follow.sourceServerIconUrl,
                    busy = state.busyId != null,
                    onResume = { model.resume(follow) },
                    onUnfollow = { model.unfollow(follow) },
                    tag = "chat.follows.row",
                )
            }
            TextButton(onClick = onDismiss, modifier = Modifier.align(Alignment.End)) {
                Text(stringResource(R.string.follow_close))
            }
        }
    }
}
