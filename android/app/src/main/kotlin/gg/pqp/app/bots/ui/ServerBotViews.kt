package gg.pqp.app.bots.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import gg.pqp.app.R
import gg.pqp.app.bots.BotNotice
import gg.pqp.app.bots.BotWork
import gg.pqp.app.bots.ServerBots
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Sizes
import gg.pqp.app.ui.theme.Spacing
import java.text.DateFormat
import java.util.Date

/**
 * BOT and BETA beside a server bot's name; "removido" in place of BETA once
 * the bot is no longer a member. Native v1's mark for a bot.
 */
@Composable
fun ServerBotTags(gone: Boolean = false, modifier: Modifier = Modifier) {
    Row(
        modifier = modifier.testTag("bot.tags"),
        horizontalArrangement = Arrangement.spacedBy(Spacing.xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = stringResource(R.string.bot_tag).uppercase(),
            style = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.Bold,
            color = MaterialTheme.colorScheme.onPrimaryContainer,
            modifier = Modifier
                .background(MaterialTheme.colorScheme.primaryContainer, MaterialTheme.shapes.extraSmall)
                .padding(horizontal = 4.dp)
                .testTag("bot.tag"),
        )
        Text(
            text = stringResource(if (gone) R.string.bot_removed else R.string.bot_beta).uppercase(),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier
                .background(MaterialTheme.colorScheme.surfaceContainerHighest, MaterialTheme.shapes.extraSmall)
                .padding(horizontal = 4.dp)
                .testTag(if (gone) "bot.removed" else "bot.beta"),
        )
    }
}

/**
 * What the server bots in this channel are doing, in place of "is typing":
 * their name with the tags, and "Pensando…" or the tool's phrase.
 */
@Composable
fun BotActivityStrip(work: Collection<BotWork>) {
    if (work.isEmpty()) return
    Surface(color = MaterialTheme.colorScheme.surfaceContainer) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = Spacing.gutter, vertical = Spacing.xs)
                .testTag("bot.activity"),
            verticalArrangement = Arrangement.spacedBy(Spacing.xs),
        ) {
            for (bot in work.sortedBy { it.name }) {
                Column {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            text = bot.name,
                            style = MaterialTheme.typography.labelMedium,
                            fontWeight = FontWeight.Bold,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f, fill = false),
                        )
                        Spacer(Modifier.width(Spacing.sm))
                        ServerBotTags()
                    }
                    Text(
                        text = stringResource(ServerBots.activityRes(bot.tool), bot.name),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

/** The clock time a bot answers again, in the reader's own format. */
private fun clock(ms: Long): String = DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(ms))

/** "The bot did not answer you", above the composer, dismissible, for this member only. */
@Composable
fun BotNoticeStrip(notice: BotNotice?, onDismiss: () -> Unit) {
    if (notice == null) return
    val text = stringResource(
        notice.textRes(),
        notice.botName,
        notice.limit ?: 0,
        notice.retryAtMs?.let(::clock).orEmpty(),
    )
    Surface(color = MaterialTheme.colorScheme.surfaceContainer) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = Spacing.gutter, end = Spacing.sm)
                .testTag("bot.notice"),
        ) {
            Column(Modifier.weight(1f).padding(vertical = Spacing.xs)) {
                Text(text = text, style = MaterialTheme.typography.bodySmall)
                Text(
                    text = stringResource(R.string.bot_notice_only_you),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            IconButton(onClick = onDismiss, modifier = Modifier.testTag("bot.notice.dismiss")) {
                Icon(
                    PqpIcons.Close,
                    contentDescription = stringResource(R.string.bot_notice_dismiss),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(Sizes.iconInline),
                )
            }
        }
    }
}
