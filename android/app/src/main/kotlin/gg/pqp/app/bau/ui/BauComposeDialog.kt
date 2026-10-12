package gg.pqp.app.bau.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.StringRes
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import coil3.compose.AsyncImage
import gg.pqp.app.R
import gg.pqp.app.attachments.formatAttachmentSize
import gg.pqp.app.bau.BAU_BODY_MAX
import gg.pqp.app.bau.BAU_TITLE_MAX
import gg.pqp.app.bau.BauChannelRefs
import gg.pqp.app.bau.BauComposeGate
import gg.pqp.app.bau.BauComposeProblem
import gg.pqp.app.bau.BauComposeViewModel
import gg.pqp.app.bau.BauLinks
import gg.pqp.app.bau.BauPickFailure
import gg.pqp.app.bau.BauRefusal
import gg.pqp.app.bau.CommunityHomeConfig
import gg.pqp.app.bau.ContentBauFiles
import gg.pqp.app.bau.YoutubeLinks
import gg.pqp.app.core.Channel
import gg.pqp.app.core.PermissionsSnapshot
import gg.pqp.app.core.SessionStore
import gg.pqp.app.core.serverPermissions
import gg.pqp.app.ui.components.ChromeDivider
import gg.pqp.app.ui.components.pqpTopBarColors
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Sizes
import gg.pqp.app.ui.theme.Spacing

/**
 * Whether to offer "new post" on this server's Baú.
 *
 * Asks the server which bits this account holds ([BauComposeGate]) and says
 * no until it answers, so the button appears a beat after the feed rather
 * than ever appearing for somebody the server would refuse.
 */
@Composable
fun rememberCanPostToBau(session: SessionStore, serverId: String, config: CommunityHomeConfig): Boolean {
    val permissions by produceState<PermissionsSnapshot?>(initialValue = null, serverId) {
        value = runCatching { session.api.serverPermissions(serverId) }.getOrNull()
    }
    return BauComposeGate.canPost(config, permissions)
}

@StringRes
internal fun problemText(problem: BauComposeProblem): Int = when (problem) {
    BauComposeProblem.NeedsTitle -> R.string.bau_compose_err_needs_title
    BauComposeProblem.NeedsContent -> R.string.bau_compose_err_needs_content
    BauComposeProblem.TitleTooLong -> R.string.bau_compose_err_title_long
    BauComposeProblem.BodyTooLong -> R.string.bau_compose_err_body_long
    BauComposeProblem.OneMediaSource -> R.string.bau_compose_err_one_source
    BauComposeProblem.BadLink -> R.string.bau_compose_err_bad_link
    BauComposeProblem.FileStillUploading -> R.string.bau_compose_err_uploading
    BauComposeProblem.FileFailed -> R.string.bau_compose_upload_failed
}

@StringRes
internal fun pickFailureText(failure: BauPickFailure): Int = when (failure) {
    BauPickFailure.Unreadable -> R.string.bau_compose_pick_unreadable
    BauPickFailure.UnsupportedType -> R.string.bau_compose_pick_unsupported
    BauPickFailure.TooLarge -> R.string.bau_compose_pick_too_large
}

/** The sentence for a refusal, with the server's own words appended for a 400. */
@Composable
internal fun refusalText(refusal: BauRefusal): String = when (refusal) {
    BauRefusal.NotStaff -> stringResource(R.string.bau_compose_refused_not_staff)
    BauRefusal.Unavailable -> stringResource(R.string.bau_compose_refused_unavailable)
    BauRefusal.TooLarge -> stringResource(R.string.bau_compose_refused_too_large)
    BauRefusal.SlowDown -> stringResource(R.string.bau_compose_refused_slow_down)
    BauRefusal.NoStorage -> stringResource(R.string.bau_compose_refused_no_storage)
    BauRefusal.Network -> stringResource(R.string.bau_compose_refused_network)
    BauRefusal.Unconfirmed -> stringResource(R.string.bau_compose_refused_unconfirmed)
    is BauRefusal.Invalid -> refusal.serverMessage
        ?.let { stringResource(R.string.bau_compose_refused_invalid, it) }
        ?: stringResource(R.string.bau_compose_refused_generic)
}

/**
 * The composer: a title, some words, one photo or video or one link.
 *
 * A full-screen dialog rather than a route, so the feed behind it keeps its
 * scroll position and a post that lands refreshes the screen the person is
 * already on. The Photo Picker is the system one, which needs no storage
 * permission at all: the app is only ever handed what was tapped.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BauComposeDialog(
    session: SessionStore,
    serverId: String,
    config: CommunityHomeConfig,
    onDismiss: () -> Unit,
    onPosted: () -> Unit,
    channels: List<Channel> = emptyList(),
) {
    val context = LocalContext.current
    val model: BauComposeViewModel = viewModel(
        key = "bau-compose-$serverId",
        factory = BauComposeViewModel.factory(session, serverId, ContentBauFiles(context)),
    )
    val state by model.state.collectAsStateWithLifecycle()
    val draft = state.draft
    var confirmDiscard by remember { mutableStateOf(false) }

    // `#name` typed or picked is stored as `<#id>`; the model needs the list to do it.
    LaunchedEffect(channels) { model.setChannels(channels) }

    LaunchedEffect(state.posted) {
        if (state.posted) {
            // Emptied before the next opening, so a posted flag never closes it.
            model.reset()
            onPosted()
        }
    }

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri != null) model.pickMedia(uri.toString())
    }

    fun close() {
        if (state.posting) return
        if (model.isDirty() && !state.posted) confirmDiscard = true else onDismiss()
    }

    Dialog(
        onDismissRequest = ::close,
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        Scaffold(
            modifier = Modifier.fillMaxSize().imePadding().testTag("bau.compose"),
            topBar = {
                Column {
                    TopAppBar(
                        title = { Text(stringResource(R.string.bau_compose_title)) },
                        navigationIcon = {
                            IconButton(onClick = ::close, enabled = !state.posting) {
                                Icon(
                                    PqpIcons.Close,
                                    contentDescription = stringResource(R.string.bau_compose_close),
                                    modifier = Modifier.size(Sizes.iconAction),
                                )
                            }
                        },
                        actions = {
                            Button(
                                onClick = model::post,
                                enabled = !state.posting,
                                modifier = Modifier.padding(end = Spacing.sm).testTag("bau.compose.post"),
                            ) {
                                if (state.posting) {
                                    CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                                } else {
                                    Text(stringResource(R.string.bau_compose_publish))
                                }
                            }
                        },
                        colors = pqpTopBarColors(),
                    )
                    ChromeDivider()
                }
            },
        ) { padding ->
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = Spacing.gutter, vertical = Spacing.md),
                verticalArrangement = Arrangement.spacedBy(Spacing.md),
            ) {
                OutlinedTextField(
                    value = draft.title,
                    onValueChange = model::setTitle,
                    placeholder = { Text(stringResource(R.string.bau_compose_title_hint)) },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                    supportingText = {
                        if (draft.title.length > BAU_TITLE_MAX * 9 / 10) {
                            Text("${draft.title.length}/$BAU_TITLE_MAX")
                        }
                    },
                    isError = draft.title.length > BAU_TITLE_MAX,
                    enabled = !state.posting,
                    modifier = Modifier.fillMaxWidth().testTag("bau.compose.title"),
                )
                OutlinedTextField(
                    value = draft.body,
                    onValueChange = model::setBody,
                    placeholder = { Text(stringResource(R.string.bau_compose_body_hint)) },
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                    minLines = 5,
                    supportingText = {
                        if (draft.body.length > BAU_BODY_MAX * 9 / 10) {
                            Text("${draft.body.length}/$BAU_BODY_MAX")
                        }
                    },
                    isError = draft.body.length > BAU_BODY_MAX,
                    enabled = !state.posting,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 140.dp).testTag("bau.compose.body"),
                )

                // `#` picker. The field is a plain string, so this follows the end
                // of the text: while the draft ends in `#ge`, the matching channels
                // are offered and a tap swaps the token for `#name`.
                val channelQuery = remember(draft.body) {
                    BauChannelRefs.findQuery(draft.body, draft.body.length)
                }
                val channelMatches = remember(channelQuery, channels) {
                    channelQuery?.let { BauChannelRefs.filter(channels, it.query) }.orEmpty()
                }
                if (channelQuery != null && channelMatches.isNotEmpty() && !state.posting) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .horizontalScroll(rememberScrollState())
                            .testTag("bau.compose.channels"),
                        horizontalArrangement = Arrangement.spacedBy(Spacing.sm),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        channelMatches.forEach { channel ->
                            AssistChip(
                                onClick = {
                                    model.setBody(
                                        BauChannelRefs.apply(draft.body, channelQuery, channel, channels).value,
                                    )
                                },
                                label = { Text("#${channel.name}") },
                                modifier = Modifier.testTag("bau.compose.channel.${channel.id}"),
                            )
                        }
                    }
                }

                val media = draft.media
                if (media != null) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(MaterialTheme.shapes.medium)
                            .background(MaterialTheme.colorScheme.surfaceContainer)
                            .padding(Spacing.md)
                            .testTag("bau.compose.media"),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(Spacing.md),
                    ) {
                        Icon(
                            imageVector = PqpIcons.Attach,
                            contentDescription = null,
                            modifier = Modifier.size(Sizes.iconAction),
                        )
                        Column(Modifier.weight(1f)) {
                            Text(media.filename, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(
                                text = when {
                                    media.uploading -> stringResource(R.string.bau_compose_uploading)
                                    media.failed -> stringResource(R.string.bau_compose_upload_failed)
                                    else -> formatAttachmentSize(media.byteSize)
                                },
                                style = MaterialTheme.typography.bodySmall,
                                color = if (media.failed) {
                                    MaterialTheme.colorScheme.error
                                } else {
                                    MaterialTheme.colorScheme.onSurfaceVariant
                                },
                            )
                        }
                        if (media.uploading) {
                            CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                        }
                        TextButton(onClick = model::removeMedia, enabled = !state.posting) {
                            Text(stringResource(R.string.bau_compose_remove))
                        }
                    }
                } else if (BauComposeGate.canAttachFiles(config)) {
                    OutlinedButton(
                        onClick = {
                            picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo))
                        },
                        modifier = Modifier.fillMaxWidth().testTag("bau.compose.attach"),
                    ) {
                        Icon(PqpIcons.Attach, contentDescription = null, modifier = Modifier.size(Sizes.iconAction))
                        Text(
                            text = stringResource(R.string.bau_compose_attach),
                            modifier = Modifier.padding(start = Spacing.sm),
                        )
                    }
                }

                if (media == null) {
                    OutlinedTextField(
                        value = draft.link,
                        onValueChange = model::setLink,
                        placeholder = { Text(stringResource(R.string.bau_compose_link_hint)) },
                        singleLine = true,
                        enabled = !state.posting,
                        keyboardOptions = KeyboardOptions(
                            keyboardType = KeyboardType.Uri,
                            capitalization = KeyboardCapitalization.None,
                        ),
                        modifier = Modifier.fillMaxWidth().testTag("bau.compose.link"),
                    )
                    val provider = BauLinks.provider(draft.link)
                    if (provider != null) {
                        LinkPreview(provider, draft.link)
                    }
                }

                val problem = state.problem
                val refusal = state.refusal
                val pickFailure = state.pickFailure
                when {
                    problem != null -> ErrorLine(stringResource(problemText(problem), BAU_TITLE_MAX))
                    pickFailure != null -> ErrorLine(stringResource(pickFailureText(pickFailure)))
                    refusal != null -> ErrorLine(refusalText(refusal))
                }
            }
        }
    }

    if (confirmDiscard) {
        AlertDialog(
            onDismissRequest = { confirmDiscard = false },
            title = { Text(stringResource(R.string.bau_compose_discard_title)) },
            confirmButton = {
                TextButton(onClick = { confirmDiscard = false; model.discard(); onDismiss() }) {
                    Text(stringResource(R.string.bau_compose_discard))
                }
            },
            dismissButton = {
                TextButton(onClick = { confirmDiscard = false }) {
                    Text(stringResource(R.string.bau_compose_keep_writing))
                }
            },
        )
    }
}

@Composable
private fun ErrorLine(text: String) {
    Text(
        text = text,
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.error,
        modifier = Modifier.fillMaxWidth().testTag("bau.compose.error"),
    )
}

/**
 * What the link will be. A YouTube link shows its public thumbnail, the same
 * one the feed shows; the other three name their provider, because the phone
 * does not embed any of them and the server decides what it will accept.
 */
@Composable
private fun LinkPreview(provider: BauLinks.Provider, link: String) {
    val name = when (provider) {
        BauLinks.Provider.Youtube -> "YouTube"
        BauLinks.Provider.Twitch -> "Twitch"
        BauLinks.Provider.TikTok -> "TikTok"
        BauLinks.Provider.Instagram -> "Instagram"
    }
    val thumbnail = YoutubeLinks.thumbnailUrl(link)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.medium)
            .background(MaterialTheme.colorScheme.surfaceContainer)
            .testTag("bau.compose.link.preview"),
    ) {
        if (thumbnail != null) {
            AsyncImage(
                model = thumbnail,
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxWidth().heightIn(max = 180.dp),
            )
        }
        Text(
            text = stringResource(R.string.bau_compose_link_ok, name),
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.padding(Spacing.md),
        )
    }
}
