package gg.pqp.app.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import gg.pqp.app.R
import gg.pqp.app.core.ChancePayload
import gg.pqp.app.ui.theme.Palette
import gg.pqp.app.ui.theme.TabularFigures

@Composable
fun ChanceCard(chance: ChancePayload, modifier: Modifier = Modifier) {
    Column(
        modifier = modifier
            .background(MaterialTheme.colorScheme.surfaceContainer, RoundedCornerShape(16.dp))
            .padding(horizontal = 14.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.Bottom,
        ) {
            Text(
                text = commandLabel(chance.type),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (chance.type == "roll" && !chance.notation.isNullOrBlank()) {
                Text(
                    text = chance.notation,
                    style = MaterialTheme.typography.labelMedium.copy(
                        fontFeatureSettings = TabularFigures,
                    ),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (!chance.comment.isNullOrBlank()) {
                Text(
                    text = chance.comment,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        }
        when (chance.type) {
            "roll" -> RollBody(chance)
            "flip" -> Text(
                text = if (chance.result == "heads") {
                    stringResource(R.string.chance_heads)
                } else {
                    stringResource(R.string.chance_tails)
                },
                style = MaterialTheme.typography.headlineSmall,
            )
            "choose" -> Text(
                text = chance.picked.orEmpty(),
                style = MaterialTheme.typography.headlineSmall,
            )
            "draw" -> DrawBody(chance)
            "shuffle" -> Text(
                text = stringResource(R.string.chance_shuffled, chance.remaining ?: 52),
                style = MaterialTheme.typography.titleLarge,
            )
        }
    }
}

@Composable
private fun RollBody(chance: ChancePayload) {
    val faces = dieFaces(chance)
    val total = chance.total ?: 0
    val crit = chance.notation.orEmpty().contains("d20") &&
        chance.faces.size == 1 &&
        chance.modifier == 0
    val totalColor = when {
        crit && total == 20 -> Palette.Signal
        crit && total == 1 -> Palette.Danger
        else -> MaterialTheme.colorScheme.onSurface
    }
    Row(
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            faces.forEach { (value, sides) ->
                DieChip(value = value, sides = sides)
            }
        }
        Text(
            text = "$total",
            style = MaterialTheme.typography.headlineMedium.copy(
                fontFeatureSettings = TabularFigures,
            ),
            color = totalColor,
        )
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun DrawBody(chance: ChancePayload) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (chance.cards.size <= 5) {
            Row(horizontalArrangement = Arrangement.spacedBy((-8).dp)) {
                chance.cards.forEach { code -> PlayingCardChip(code) }
            }
        } else {
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                chance.cards.forEach { code -> PlayingCardChip(code) }
            }
        }
        chance.remaining?.let { left ->
            Text(
                text = if (chance.reshuffled == true) {
                    stringResource(R.string.chance_new_deck, left)
                } else {
                    stringResource(R.string.chance_left, left)
                },
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun DieChip(value: Int, sides: Int) {
    val crit20 = sides == 20 && value == 20
    val crit1 = sides == 20 && value == 1
    val color = when {
        crit20 -> Palette.Signal
        crit1 -> Palette.Danger
        else -> Palette.Ink
    }
    Box(
        modifier = Modifier
            .size(36.dp)
            .background(Palette.Paper, RoundedCornerShape(10.dp)),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = "$value",
            color = color,
            fontSize = 16.sp,
            style = MaterialTheme.typography.titleMedium.copy(
                fontFeatureSettings = TabularFigures,
            ),
        )
    }
}

@Composable
private fun PlayingCardChip(code: String) {
    val suit = code.lastOrNull()?.toString().orEmpty()
    val rank = code.dropLast(1)
    val red = suit == "H" || suit == "D"
    val pip = when (suit) {
        "S" -> "♠"
        "H" -> "♥"
        "D" -> "♦"
        "C" -> "♣"
        else -> suit
    }
    Column(
        modifier = Modifier
            .size(width = 36.dp, height = 52.dp)
            .background(Palette.Paper, RoundedCornerShape(6.dp))
            .padding(top = 4.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = rank,
            color = if (red) Palette.Danger else Palette.Ink,
            fontSize = 11.sp,
        )
        Text(
            text = pip,
            color = if (red) Palette.Danger else Palette.Ink,
            fontSize = 14.sp,
        )
    }
}

private fun commandLabel(type: String): String = when (type) {
    "roll" -> "/roll"
    "flip" -> "/flip"
    "choose" -> "/choose"
    "draw" -> "/draw"
    "shuffle" -> "/shuffle"
    else -> "/$type"
}

private fun dieFaces(chance: ChancePayload): List<Pair<Int, Int>> {
    if (chance.groups.isNotEmpty()) {
        return chance.groups.flatMap { group -> group.faces.map { it to group.sides } }
    }
    val sides = Regex("""d(\d+)""", RegexOption.IGNORE_CASE)
        .find(chance.notation.orEmpty())
        ?.groupValues
        ?.getOrNull(1)
        ?.toIntOrNull()
        ?: 20
    return chance.faces.map { it to sides }
}
