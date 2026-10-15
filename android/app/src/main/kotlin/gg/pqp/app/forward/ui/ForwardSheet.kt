package gg.pqp.app.forward.ui

import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import gg.pqp.app.R
import gg.pqp.app.core.SessionStore
import gg.pqp.app.forward.FORWARD_COMMENT_MAX
import gg.pqp.app.forward.ForwardDone
import gg.pqp.app.forward.ForwardFailure
import gg.pqp.app.forward.ForwardInput
import gg.pqp.app.forward.ForwardRefusal
import gg.pqp.app.forward.ForwardServerGroup
import gg.pqp.app.forward.ForwardTarget
import gg.pqp.app.forward.ForwardTargets
import gg.pqp.app.forward.ForwardViewModel
import gg.pqp.app.forward.TargetRefusal
import gg.pqp.app.ui.components.Avatar
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Sizes
import gg.pqp.app.ui.theme.Spacing
import java.util.UUID

/**
 * Encaminhar's picker: search servers, channels and people you can send to,
 * recent ones first, tick up to five, add a few words of your own, send.
 *
 * One bottom sheet for both entry points (a message's long press, a Baú post's
 * menu). It stays open while any target is refused, with the reason on that
 * row, so a slow-mode channel does not cost the four that went through.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ForwardSheet(
    session: SessionStore,
    input: ForwardInput,
    onDismiss: () -> Unit,
    onDone: (ForwardDone) -> Unit,
) {
    val context = LocalContext.current
    val instance = remember { UUID.randomUUID().toString() }
    val model: ForwardViewModel = viewModel(
        key = "forward-$instance",
        factory = ForwardViewModel.factory(session, input, context),
    )
    val state by model.state.collectAsStateWithLifecycle()
    val done by model.done.collectAsStateWithLifecycle()

    // The sheet is finished with once everything went (or the person left): say
    // what was sent, once, then go. Leaving a half-sent sheet reports what did go.
    LaunchedEffect(done) {
        done?.let {
            onDone(it)
            onDismiss()
        }
    }

    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = {
            model.finish()
            // `done` carries a send to the host; with nothing sent there is no
            // `done` and the sheet simply closes.
            if (model.done.value == null) onDismiss()
        },
        sheetState = sheetState,
        modifier = Modifier.testTag("forward.sheet"),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .fillMaxHeight(0.92f)
                .navigationBarsPadding()
                .imePadding(),
        ) {
            Column(Modifier.padding(horizontal = Spacing.gutter)) {
                Text(
                    text = stringResource(R.string.forward_title),
                    style = MaterialTheme.typography.titleLarge,
                )
                Text(
                    text = input.preview,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.testTag("forward.preview"),
                )
                Spacer(Modifier.size(Spacing.md))
                SearchField(state.query, model::setQuery)
            }

            if (input.restrictedToServerId != null) {
                val serverName = state.groups.firstOrNull { it.serverId == input.restrictedToServerId }?.serverName
                    ?: session.servers.collectAsState().value
                        .firstOrNull { it.id == input.restrictedToServerId }?.name.orEmpty()
                Text(
                    text = stringResource(R.string.forward_restricted_note, serverName),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier
                        .padding(horizontal = Spacing.gutter, vertical = Spacing.sm)
                        .testTag("forward.restricted"),
                )
            }

            val list = remember(state.groups, state.people, state.recents, state.query) {
                ForwardTargets.list(
                    groups = state.groups,
                    people = state.people,
                    recents = state.recents,
                    query = state.query,
                    restrictedToServerId = input.restrictedToServerId,
                )
            }

            Box(Modifier.weight(1f)) {
                when {
                    list.isEmpty && state.loading -> Column(
                        Modifier.fillMaxWidth().padding(Spacing.xl),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        CircularProgressIndicator(Modifier.size(Sizes.iconAction), strokeWidth = 2.dp)
                        Spacer(Modifier.size(Spacing.sm))
                        Text(
                            text = stringResource(R.string.forward_loading),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }

                    list.isEmpty -> Text(
                        text = stringResource(R.string.forward_none_found),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(Spacing.xl)
                            .testTag("forward.none"),
                    )

                    else -> LazyColumn(Modifier.fillMaxWidth().testTag("forward.list")) {
                        if (list.recent.isNotEmpty()) {
                            item(key = "h-recent") {
                                SectionHeader(stringResource(R.string.forward_section_recent))
                            }
                            items(list.recent, key = { "r-" + it.key }) { target ->
                                TargetRow(target, state.selected, state.sentKeys, state.refusals, showServer = true) {
                                    model.toggle(target.key)
                                }
                            }
                        }
                        if (list.people.isNotEmpty()) {
                            item(key = "h-people") {
                                SectionHeader(stringResource(R.string.forward_section_people))
                            }
                            items(list.people, key = { "p-" + it.key }) { target ->
                                TargetRow(target, state.selected, state.sentKeys, state.refusals, showServer = false) {
                                    model.toggle(target.key)
                                }
                            }
                        }
                        list.servers.forEach { group ->
                            item(key = "h-" + group.serverId) { ServerHeader(group) }
                            items(group.channels, key = { "s-" + it.key }) { target ->
                                TargetRow(target, state.selected, state.sentKeys, state.refusals, showServer = false) {
                                    model.toggle(target.key)
                                }
                            }
                        }
                        if (state.loading) {
                            item(key = "loading") {
                                Box(Modifier.fillMaxWidth().padding(Spacing.lg), Alignment.Center) {
                                    CircularProgressIndicator(Modifier.size(Sizes.iconAction), strokeWidth = 2.dp)
                                }
                            }
                        }
                    }
                }
            }

            Footer(
                state = state,
                onComment = model::setComment,
                onSend = model::send,
            )
        }
    }
}

@Composable
private fun SearchField(query: String, onChange: (String) -> Unit) {
    val container = MaterialTheme.colorScheme.surfaceContainerHigh
    TextField(
        value = query,
        onValueChange = onChange,
        modifier = Modifier.fillMaxWidth().testTag("forward.search"),
        singleLine = true,
        shape = MaterialTheme.shapes.small,
        textStyle = MaterialTheme.typography.bodyLarge,
        leadingIcon = {
            Icon(PqpIcons.Search, contentDescription = null, modifier = Modifier.size(Sizes.iconInline))
        },
        placeholder = {
            Text(stringResource(R.string.forward_search_hint), style = MaterialTheme.typography.bodyLarge)
        },
        colors = TextFieldDefaults.colors(
            focusedContainerColor = container,
            unfocusedContainerColor = container,
            disabledContainerColor = container,
            focusedIndicatorColor = Color.Transparent,
            unfocusedIndicatorColor = Color.Transparent,
            disabledIndicatorColor = Color.Transparent,
            focusedLeadingIconColor = MaterialTheme.colorScheme.onSurfaceVariant,
            unfocusedLeadingIconColor = MaterialTheme.colorScheme.onSurfaceVariant,
            focusedPlaceholderColor = MaterialTheme.colorScheme.onSurfaceVariant,
            unfocusedPlaceholderColor = MaterialTheme.colorScheme.onSurfaceVariant,
            cursorColor = MaterialTheme.colorScheme.primary,
        ),
        keyboardOptions = KeyboardOptions(
            capitalization = KeyboardCapitalization.None,
            autoCorrectEnabled = false,
            imeAction = ImeAction.Search,
        ),
    )
}

@Composable
private fun SectionHeader(text: String) {
    Text(
        text = text.uppercase(),
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.fillMaxWidth().padding(
            start = Spacing.gutter,
            end = Spacing.gutter,
            top = Spacing.lg,
            bottom = Spacing.xs,
        ),
    )
}

@Composable
private fun ServerHeader(group: ForwardServerGroup) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.fillMaxWidth().padding(
            start = Spacing.gutter,
            end = Spacing.gutter,
            top = Spacing.lg,
            bottom = Spacing.xs,
        ),
    ) {
        Avatar(name = group.serverName, url = group.iconUrl, size = 20.dp, cornerRadius = 6.dp)
        Spacer(Modifier.width(Spacing.sm))
        Text(
            text = group.serverName.uppercase(),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun TargetRow(
    target: ForwardTarget,
    selected: List<String>,
    sentKeys: Set<String>,
    refusals: Map<String, TargetRefusal>,
    showServer: Boolean,
    onClick: () -> Unit,
) {
    val isSelected = target.key in selected
    val isSent = target.key in sentKeys
    val refusal = refusals[target.key]
    val colors = MaterialTheme.colorScheme

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .toggleable(
                value = isSelected,
                enabled = !isSent,
                role = Role.Checkbox,
                onValueChange = { onClick() },
            )
            .padding(horizontal = Spacing.gutter, vertical = Spacing.sm)
            .heightIn(min = 40.dp)
            .testTag("forward.target"),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            when (target) {
                is ForwardTarget.InChannel -> {
                    Icon(
                        imageVector = if (target.isPrivate) PqpIcons.PrivateChannel else PqpIcons.TextChannel,
                        contentDescription = null,
                        tint = colors.onSurfaceVariant,
                        modifier = Modifier.size(Sizes.avatarSmall).padding(4.dp),
                    )
                }
                is ForwardTarget.Conversation -> if (target.isGroup) {
                    Icon(
                        imageVector = PqpIcons.People,
                        contentDescription = null,
                        tint = colors.onSurfaceVariant,
                        modifier = Modifier.size(Sizes.avatarSmall).padding(4.dp),
                    )
                } else {
                    Avatar(name = target.title, url = target.avatarUrl, size = Sizes.avatarSmall, seed = target.seed)
                }
                is ForwardTarget.Person -> Avatar(
                    name = target.displayName,
                    url = target.avatarUrl,
                    size = Sizes.avatarSmall,
                    seed = target.userId,
                )
            }
            Spacer(Modifier.width(Spacing.md))
            Column(Modifier.weight(1f)) {
                Text(
                    text = when (target) {
                        is ForwardTarget.InChannel -> target.channelName
                        is ForwardTarget.Conversation -> target.title
                        is ForwardTarget.Person -> target.displayName
                    },
                    style = MaterialTheme.typography.bodyLarge,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                val subtitle = when (target) {
                    is ForwardTarget.InChannel -> if (showServer) target.serverName else null
                    is ForwardTarget.Conversation -> if (target.isGroup) stringResource(R.string.forward_group) else null
                    is ForwardTarget.Person -> stringResource(R.string.forward_new_dm)
                }
                if (subtitle != null) {
                    Text(
                        text = subtitle,
                        style = MaterialTheme.typography.bodySmall,
                        color = colors.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            if (isSent) {
                Icon(
                    imageVector = PqpIcons.Confirm,
                    contentDescription = stringResource(R.string.forward_sent_badge),
                    tint = colors.primary,
                    modifier = Modifier.size(Sizes.iconAction),
                )
            } else {
                Checkbox(
                    checked = isSelected,
                    onCheckedChange = null,
                    colors = CheckboxDefaults.colors(),
                )
            }
        }
        if (refusal != null) {
            Text(
                text = refusalText(refusal),
                style = MaterialTheme.typography.bodySmall,
                color = colors.error,
                modifier = Modifier
                    .padding(start = Sizes.avatarSmall + Spacing.md, top = 2.dp)
                    .testTag("forward.refusal"),
            )
        }
    }
}

@Composable
private fun refusalText(refusal: TargetRefusal): String {
    val wait = refusal.waitSeconds
    return when (refusal.refusal) {
        ForwardRefusal.NoAccess -> stringResource(R.string.forward_refusal_no_access)
        ForwardRefusal.CannotSend -> stringResource(R.string.forward_refusal_cannot_send)
        ForwardRefusal.BadTarget -> stringResource(R.string.forward_refusal_bad_target)
        ForwardRefusal.StaysInServer -> stringResource(R.string.forward_refusal_stays_in_server)
        ForwardRefusal.Unreachable -> stringResource(R.string.forward_refusal_unreachable)
        ForwardRefusal.SlowMode -> if (wait != null) {
            stringResource(R.string.forward_refusal_slow_mode, wait)
        } else {
            stringResource(R.string.forward_refusal_slow_mode_nowait)
        }
        ForwardRefusal.RateLimited -> if (wait != null) {
            stringResource(R.string.forward_refusal_rate_limited, wait)
        } else {
            stringResource(R.string.forward_refusal_rate_limited_nowait)
        }
        ForwardRefusal.Automod -> stringResource(R.string.forward_refusal_automod)
        ForwardRefusal.Unavailable -> stringResource(R.string.forward_refusal_unavailable)
    }
}

@Composable
private fun failureText(failure: ForwardFailure): String = when (failure) {
    ForwardFailure.Gone -> stringResource(R.string.forward_failure_gone)
    ForwardFailure.NotForwardable -> stringResource(R.string.forward_failure_not_forwardable)
    ForwardFailure.Empty -> stringResource(R.string.forward_failure_empty)
    ForwardFailure.Slow -> stringResource(R.string.forward_failure_slow)
    is ForwardFailure.Other -> stringResource(R.string.forward_failure_other)
}

@Composable
private fun Footer(
    state: gg.pqp.app.forward.ForwardPickerState,
    onComment: (String) -> Unit,
    onSend: () -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    val container = colors.surfaceContainerHigh
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = Spacing.gutter, vertical = Spacing.sm),
        verticalArrangement = Arrangement.spacedBy(Spacing.sm),
    ) {
        if (state.failure != null) {
            Text(
                text = failureText(state.failure),
                style = MaterialTheme.typography.bodySmall,
                color = colors.error,
                modifier = Modifier.testTag("forward.failure"),
            )
        }
        if (state.capHit) {
            Text(
                text = stringResource(R.string.forward_cap),
                style = MaterialTheme.typography.bodySmall,
                color = colors.onSurfaceVariant,
                modifier = Modifier.testTag("forward.cap"),
            )
        }
        TextField(
            value = state.comment,
            onValueChange = onComment,
            modifier = Modifier.fillMaxWidth().testTag("forward.comment"),
            maxLines = 3,
            shape = MaterialTheme.shapes.small,
            textStyle = MaterialTheme.typography.bodyLarge,
            placeholder = {
                Text(stringResource(R.string.forward_comment_hint), style = MaterialTheme.typography.bodyLarge)
            },
            supportingText = if (state.comment.length > FORWARD_COMMENT_MAX - 100) {
                { Text("${state.comment.length}/$FORWARD_COMMENT_MAX") }
            } else {
                null
            },
            colors = TextFieldDefaults.colors(
                focusedContainerColor = container,
                unfocusedContainerColor = container,
                disabledContainerColor = container,
                focusedIndicatorColor = Color.Transparent,
                unfocusedIndicatorColor = Color.Transparent,
                disabledIndicatorColor = Color.Transparent,
                focusedPlaceholderColor = colors.onSurfaceVariant,
                unfocusedPlaceholderColor = colors.onSurfaceVariant,
                cursorColor = colors.primary,
            ),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Default),
        )
        val count = state.selected.size
        Button(
            onClick = onSend,
            enabled = count > 0 && !state.sending,
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("forward.send"),
        ) {
            if (state.sending) {
                CircularProgressIndicator(
                    modifier = Modifier.size(18.dp),
                    strokeWidth = 2.dp,
                    color = colors.onPrimary,
                )
                Spacer(Modifier.width(Spacing.sm))
                Text(stringResource(R.string.forward_sending))
            } else {
                Icon(PqpIcons.ForwardMessage, contentDescription = null, modifier = Modifier.size(Sizes.iconInline))
                Spacer(Modifier.width(Spacing.sm))
                Text(
                    if (count == 0) {
                        stringResource(R.string.forward_send_none)
                    } else {
                        stringResource(R.string.forward_send, count)
                    },
                )
            }
        }
    }
}

/** The line the host shows once something was sent, and where its "Ver" goes. */
@Composable
fun forwardSentMessage(done: ForwardDone): String =
    if (done.sent.size == 1) {
        stringResource(R.string.forward_sent_to, done.sent.first().label)
    } else {
        pluralStringResource(R.plurals.forward_sent_many, done.sent.size, done.sent.size)
    }
