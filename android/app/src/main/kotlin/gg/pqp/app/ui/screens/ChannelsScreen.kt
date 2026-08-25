package gg.pqp.app.ui.screens

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Tag
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.rememberTopAppBarState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import gg.pqp.app.R
import gg.pqp.app.core.Channel
import gg.pqp.app.core.SessionStore
import gg.pqp.app.voice.Refusal
import gg.pqp.app.voice.VoiceController
import kotlinx.coroutines.launch

/**
 * A server's channels.
 *
 * Ordering has one trap in it: `position` is unique only within a sibling
 * group, and top-level text channels, top-level voice channels and categories
 * are three separate groups that all carry `parentId == null`. Sorting them as
 * one list interleaves three sequences of 0, 1, 2. They are rendered as
 * separate sections for that reason, not for looks.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChannelsScreen(
    session: SessionStore,
    voice: VoiceController,
    serverId: String,
    serverName: String,
    onBack: () -> Unit,
    onOpenChannel: (Channel) -> Unit,
) {
    var channels by remember { mutableStateOf<List<Channel>?>(null) }
    val scrollBehavior = TopAppBarDefaults.pinnedScrollBehavior(rememberTopAppBarState())
    val context = LocalContext.current
    val snackbars = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    val voiceState by voice.state.collectAsStateWithLifecycle()

    // Held across the permission round trip: the system dialog takes the app
    // out of the foreground, so the channel that was tapped cannot be a local
    // in the click handler.
    var pendingVoice by remember { mutableStateOf<Channel?>(null) }

    val micDenied = stringResource(R.string.voice_mic_denied)
    val callPermissions = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { _ ->
        val channel = pendingVoice
        pendingVoice = null
        // Only the microphone gates the call. Notifications are asked for in
        // the same breath because the foreground service's notification is what
        // the person uses to get back to the call and to hang up, and a refusal
        // there leaves a call running that nothing on screen mentions.
        //
        // The answer is read back from the permission itself rather than from
        // the results map: the map only carries what was *asked* this time, so
        // a request that only needed notifications would otherwise read as a
        // microphone refusal.
        val micGranted =
            ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
                PackageManager.PERMISSION_GRANTED
        when {
            micGranted && channel != null -> voice.join(channel.id, channel.name)
            !micGranted -> scope.launch { snackbars.showSnackbar(micDenied) }
        }
    }

    fun joinVoice(channel: Channel) {
        val wanted = buildList {
            if (
                ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) !=
                PackageManager.PERMISSION_GRANTED
            ) {
                add(Manifest.permission.RECORD_AUDIO)
            }
            if (
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) !=
                PackageManager.PERMISSION_GRANTED
            ) {
                add(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
        if (wanted.isEmpty()) {
            voice.join(channel.id, channel.name)
        } else {
            pendingVoice = channel
            callPermissions.launch(wanted.toTypedArray())
        }
    }

    val roomFull = stringResource(R.string.voice_room_full)
    val unsupported = stringResource(R.string.voice_transport_unsupported)
    LaunchedEffect(voiceState.refusal) {
        when (voiceState.refusal) {
            Refusal.RoomFull -> snackbars.showSnackbar(roomFull)
            Refusal.TransportUnsupported -> snackbars.showSnackbar(unsupported)
            null -> return@LaunchedEffect
        }
        voice.dismissRefusal()
    }

    LaunchedEffect(serverId) {
        channels = runCatching { session.api.channels(serverId) }.getOrDefault(emptyList())
    }

    Scaffold(
        modifier = Modifier
            .fillMaxSize()
            .nestedScroll(scrollBehavior.nestedScrollConnection),
        topBar = {
            TopAppBar(
                title = { Text(serverName) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.chat_back),
                        )
                    }
                },
                scrollBehavior = scrollBehavior,
            )
        },
        snackbarHost = { SnackbarHost(snackbars) },
    ) { padding ->
        val list = channels
        when {
            list == null -> Box(
                Modifier.fillMaxSize().padding(padding),
                contentAlignment = Alignment.Center,
            ) { CircularProgressIndicator() }

            list.isEmpty() -> Box(Modifier.padding(padding)) {
                EmptyState(stringResource(R.string.channels_empty))
            }

            else -> {
                val sections = remember(list) { sectionsOf(list) }
                LazyColumn(
                    modifier = Modifier.fillMaxSize().padding(padding),
                    contentPadding = PaddingValues(bottom = 24.dp),
                ) {
                    sections.forEach { section ->
                        item(key = "header-${section.key}") {
                            SectionHeader(section.title)
                        }
                        items(section.channels.size, key = { section.channels[it].id }) { index ->
                            val channel = section.channels[index]
                            ChannelRow(
                                channel = channel,
                                inCall = voiceState.channelId == channel.id,
                                onClick = {
                                    if (channel.isVoice) joinVoice(channel) else onOpenChannel(channel)
                                },
                            )
                        }
                    }
                }
            }
        }
    }
}

private data class Section(val key: String, val title: String, val channels: List<Channel>)

/**
 * Categories first as containers, then whatever sits at the top level.
 *
 * A category is a channel row with `type == "category"`, not a separate object,
 * and its children point at it through `parentId`.
 */
private fun sectionsOf(all: List<Channel>): List<Section> {
    val categories = all.filter { it.isCategory }.sortedBy { it.position }
    val byParent = all.filterNot { it.isCategory }.groupBy { it.parentId }

    val sections = mutableListOf<Section>()

    fun add(key: String, title: String, channels: List<Channel>) {
        if (channels.isNotEmpty()) sections += Section(key, title, channels.sortedBy { it.position })
    }

    val topLevel = byParent[null].orEmpty()
    add("top-text", "", topLevel.filter { it.isText })
    add("top-voice", "", topLevel.filter { it.isVoice })

    categories.forEach { category ->
        val children = byParent[category.id].orEmpty()
        add("cat-${category.id}-text", category.name, children.filter { it.isText })
        add("cat-${category.id}-voice", category.name, children.filter { it.isVoice })
    }

    return sections
}

@Composable
private fun SectionHeader(title: String) {
    if (title.isBlank()) {
        Spacer(Modifier.padding(top = 8.dp))
        return
    }
    Text(
        text = title.uppercase(),
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 20.dp, bottom = 6.dp),
    )
}

@Composable
private fun ChannelRow(channel: Channel, inCall: Boolean, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 20.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = when {
                channel.isPrivate -> Icons.Filled.Lock
                channel.isVoice -> Icons.AutoMirrored.Filled.VolumeUp
                else -> Icons.Filled.Tag
            },
            contentDescription = null,
            tint = if (inCall) {
                MaterialTheme.colorScheme.primary
            } else {
                MaterialTheme.colorScheme.onSurfaceVariant
            },
        )
        Spacer(Modifier.width(12.dp))
        Text(
            text = channel.name,
            style = MaterialTheme.typography.bodyLarge,
            color = if (inCall) {
                MaterialTheme.colorScheme.primary
            } else {
                MaterialTheme.colorScheme.onSurface
            },
        )
    }
}
