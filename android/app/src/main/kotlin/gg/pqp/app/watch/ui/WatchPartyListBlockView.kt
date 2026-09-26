package gg.pqp.app.watch.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import gg.pqp.app.R
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Sizes
import gg.pqp.app.ui.theme.Spacing
import gg.pqp.app.watch.WatchPartyListBlock
import gg.pqp.app.watch.WatchPartyListEntry

/**
 * The channel list's own copy of the web sidebar's `LivePartyBlock`: above
 * every category, one card per live party, or a single pending/host row when
 * nothing is live, or nothing at all. See `WatchPartyListState.kt` for the
 * four states this draws and why an idle `watch_party` channel no longer
 * gets an ordinary row (`ChannelsScreen.kt` filters it out of `sectionsOf`
 * once it has an entry here).
 *
 * [onOpen] and [onHost] both just open the channel -- there is no separate
 * "start hosting" navigation. `PqpApp.kt`'s `ChatRoute` widens its own host
 * gate with the same `START_WATCH_PARTY` check whenever there is no active
 * party, so landing there from [onHost] shows the create control immediately
 * rather than the bare idle stage a plain viewer would see.
 */
@Composable
fun WatchPartyListBlockView(
    block: WatchPartyListBlock,
    onOpen: (String) -> Unit,
    onHost: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    when (block) {
        WatchPartyListBlock.None -> Unit
        is WatchPartyListBlock.Live -> Column(
            modifier
                .fillMaxWidth()
                .padding(horizontal = Spacing.railInset, vertical = Spacing.xs)
                .testTag("channels.watchParty.live"),
        ) {
            SectionEyebrow(stringResource(R.string.watch_party_list_label))
            block.parties.forEachIndexed { index, party ->
                if (index > 0) Spacer(Modifier.padding(top = Spacing.xs))
                LivePartyCard(
                    party = party,
                    onClick = { onOpen(party.channelId) },
                )
            }
        }
        is WatchPartyListBlock.Pending -> PendingPartyRow(
            entry = block.entry,
            onClick = { onOpen(block.entry.channelId) },
            modifier = modifier.testTag("channels.watchParty.pending"),
        )
        is WatchPartyListBlock.Host -> HostPartyRow(
            entry = block.entry,
            onClick = { onHost(block.entry.channelId) },
            modifier = modifier.testTag("channels.watchParty.host"),
        )
    }
}

/** The small uppercase rule above the live cards, same job as [gg.pqp.app.ui.components.SectionLabel] but inset for this block. */
@Composable
private fun SectionEyebrow(text: String) {
    Text(
        text = text,
        style = MaterialTheme.typography.labelSmall,
        fontWeight = FontWeight.SemiBold,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(horizontal = Spacing.md, vertical = Spacing.xs),
    )
}

/**
 * A live party reads as an event, not a busy channel: the party's own name,
 * who is hosting, a live badge and -- when the server has already said so --
 * how many are watching. Same anatomy the web's card converged on, scaled
 * down to a phone-width rail: one line for the name, one for the rest.
 */
@Composable
private fun LivePartyCard(party: WatchPartyListEntry.Live, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.small)
            .background(MaterialTheme.colorScheme.errorContainer.copy(alpha = 0.16f))
            .clickable(onClick = onClick)
            .padding(horizontal = Spacing.md, vertical = Spacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(Sizes.iconInline), contentAlignment = Alignment.Center) {
            Icon(
                imageVector = PqpIcons.WatchParty,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.error,
                modifier = Modifier.size(Sizes.iconInline),
            )
        }
        Spacer(Modifier.width(Spacing.sm + 2.dp))
        Column(Modifier.weight(1f)) {
            Text(
                text = party.partyName,
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = stringResource(R.string.watch_party_list_hosted_by, party.hostDisplayName),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (party.watching != null && party.watching > 0) {
                    Text(
                        text = "  ·  " + pluralStringResource(R.plurals.watch_audience, party.watching, party.watching),
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
        Spacer(Modifier.width(Spacing.sm))
        Text(
            text = stringResource(R.string.watch_live),
            style = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.Bold,
            color = MaterialTheme.colorScheme.onError,
            modifier = Modifier
                .clip(RoundedCornerShape(4.dp))
                .background(MaterialTheme.colorScheme.error)
                .padding(horizontal = Spacing.xs, vertical = 1.dp),
        )
    }
}

/**
 * This account's own draft or scheduled party: the way back to a setup it
 * already started, so the sidebar stops offering a fresh "Host" button over
 * one that already exists.
 */
@Composable
private fun PendingPartyRow(entry: WatchPartyListEntry.Pending, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = Spacing.railInset)
            .clip(MaterialTheme.shapes.small)
            .background(MaterialTheme.colorScheme.surfaceContainerHigh)
            .clickable(onClick = onClick)
            .padding(horizontal = Spacing.md, vertical = Spacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(Sizes.iconInline), contentAlignment = Alignment.Center) {
            Icon(
                imageVector = PqpIcons.WatchParty,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(Sizes.iconInline),
            )
        }
        Spacer(Modifier.width(Spacing.sm + 2.dp))
        Column(Modifier.weight(1f)) {
            Text(
                text = entry.partyName,
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = stringResource(
                    if (entry.scheduled) {
                        R.string.watch_party_list_pending_scheduled
                    } else {
                        R.string.watch_party_list_pending_draft
                    },
                ),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/**
 * The one control a would-be host gets when nothing is running: a single
 * row, reading as an action rather than as a channel type -- the same point
 * the web's own doc makes about its create button.
 */
@Composable
private fun HostPartyRow(entry: WatchPartyListEntry.Host, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = Spacing.railInset)
            .clip(MaterialTheme.shapes.small)
            .clickable(onClick = onClick)
            .padding(horizontal = Spacing.md, vertical = Spacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(Sizes.iconInline), contentAlignment = Alignment.Center) {
            Icon(
                imageVector = PqpIcons.WatchParty,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(Sizes.iconInline),
            )
        }
        Spacer(Modifier.width(Spacing.sm + 2.dp))
        Text(
            text = stringResource(R.string.watch_party_list_host),
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurface,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}
