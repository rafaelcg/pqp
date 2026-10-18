package gg.pqp.app.communities.ui

import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import gg.pqp.app.R
import gg.pqp.app.ui.theme.PqpIcons

/**
 * "Público": the mark a server wears while strangers can walk into it.
 *
 * It exists because the setting behind it was invisible from a phone, and a
 * test server stayed open to the directory because nobody could see that it
 * was. Drawn wherever the server is named (its row on the server list, the top
 * of its channel list), only while the instance has communities on, since with
 * them off the address answers 404 and the label would be a lie.
 *
 * Text and an icon, never a colour alone.
 */
@Composable
fun PublicBadge(modifier: Modifier = Modifier) {
    Surface(
        shape = MaterialTheme.shapes.small,
        color = MaterialTheme.colorScheme.primary.copy(alpha = 0.16f),
        modifier = modifier.testTag("community.badge"),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
        ) {
            Icon(
                imageVector = PqpIcons.Public,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(12.dp),
            )
            Spacer(Modifier.width(4.dp))
            Text(
                text = stringResource(R.string.community_badge),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.primary,
                maxLines = 1,
                overflow = TextOverflow.Clip,
            )
        }
    }
}
