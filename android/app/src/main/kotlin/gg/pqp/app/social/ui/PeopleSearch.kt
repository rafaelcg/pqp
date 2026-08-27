package gg.pqp.app.social.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.text.KeyboardOptions
import gg.pqp.app.R
import gg.pqp.app.social.PublicUser
import gg.pqp.app.social.SocialRepository
import gg.pqp.app.social.USER_SEARCH_MIN_LENGTH
import gg.pqp.app.ui.components.Avatar
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Sizes
import gg.pqp.app.ui.theme.Spacing
import kotlinx.coroutines.delay

/** What a people search is currently showing. */
class PeopleSearchState {
    var query by mutableStateOf("")
    var results by mutableStateOf<List<PublicUser>>(emptyList())
    var searching by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)

    val isTyping: Boolean get() = query.trim().length >= USER_SEARCH_MIN_LENGTH
    val looksLikeTag: Boolean get() = SocialRepository.looksLikeTag(query.trim())
}

@Composable
fun rememberPeopleSearch(): PeopleSearchState = remember { PeopleSearchState() }

/**
 * A debounced search over the two user-lookup endpoints.
 *
 * Debounced because user search is the tightest-budgeted endpoint on the
 * server: it is the one place this product answers questions about people you
 * share nothing with, so a request per keystroke gets rate-limited inside a
 * word, and the reader sees a 429 for typing normally.
 */
@Composable
fun PeopleSearchEffect(state: PeopleSearchState, social: SocialRepository) {
    LaunchedEffect(state.query) {
        val term = state.query.trim()
        if (term.length < USER_SEARCH_MIN_LENGTH) {
            state.results = emptyList()
            state.error = null
            state.searching = false
            return@LaunchedEffect
        }
        delay(SEARCH_DEBOUNCE_MS)
        state.searching = true
        social.searchPeople(term)
            .onSuccess {
                state.results = it
                state.error = null
            }
            .onFailure { state.error = it.message }
        state.searching = false
    }
}

/**
 * The field.
 *
 * Filled rather than outlined, and the indicator underneath it is removed. A
 * filled field already says where it is by being a different surface, and the
 * design language spends its one hairline on the seam between chrome and
 * content rather than on a box around an input. `surfaceContainerHigh` in every
 * state on purpose: a field that changes colour on focus is a field that
 * flashes each time the keyboard opens, and the cursor is enough of a focus
 * indicator.
 */
@Composable
fun PeopleSearchField(
    state: PeopleSearchState,
    modifier: Modifier = Modifier,
    tag: String = "people.search",
) {
    val container = MaterialTheme.colorScheme.surfaceContainerHigh
    TextField(
        value = state.query,
        onValueChange = { state.query = it.take(32) },
        modifier = modifier
            .fillMaxWidth()
            .testTag(tag),
        singleLine = true,
        shape = MaterialTheme.shapes.small,
        textStyle = MaterialTheme.typography.bodyLarge,
        leadingIcon = {
            Icon(
                imageVector = PqpIcons.Search,
                contentDescription = null,
                modifier = Modifier.size(Sizes.iconInline),
            )
        },
        placeholder = {
            Text(
                text = stringResource(R.string.people_search_hint),
                style = MaterialTheme.typography.bodyLarge,
            )
        },
        colors = TextFieldDefaults.colors(
            focusedContainerColor = container,
            unfocusedContainerColor = container,
            disabledContainerColor = container,
            errorContainerColor = container,
            focusedIndicatorColor = Color.Transparent,
            unfocusedIndicatorColor = Color.Transparent,
            disabledIndicatorColor = Color.Transparent,
            errorIndicatorColor = Color.Transparent,
            focusedLeadingIconColor = MaterialTheme.colorScheme.onSurfaceVariant,
            unfocusedLeadingIconColor = MaterialTheme.colorScheme.onSurfaceVariant,
            focusedPlaceholderColor = MaterialTheme.colorScheme.onSurfaceVariant,
            unfocusedPlaceholderColor = MaterialTheme.colorScheme.onSurfaceVariant,
            cursorColor = MaterialTheme.colorScheme.primary,
        ),
        keyboardOptions = KeyboardOptions(
            // A handle is never capitalised and never autocorrected. Letting the
            // keyboard do either turns `rafa#1234` into `Rafa#1234` and an exact
            // lookup into a 404.
            capitalization = KeyboardCapitalization.None,
            autoCorrectEnabled = false,
            imeAction = ImeAction.Search,
        ),
    )
}

/**
 * The line under the field when there is nothing to list. It is the only place
 * the `name#1234` form is taught, so it says it rather than leaving a void.
 */
@Composable
fun PeopleSearchStatus(state: PeopleSearchState, emptyHint: String) {
    val message = when {
        state.searching -> null
        state.error != null -> state.error
        !state.isTyping -> emptyHint
        state.results.isEmpty() && state.looksLikeTag -> stringResource(R.string.people_search_no_tag)
        state.results.isEmpty() -> stringResource(R.string.people_search_no_matches)
        else -> null
    }

    if (state.searching) {
        Box(Modifier.fillMaxWidth().padding(Spacing.xl), contentAlignment = Alignment.Center) {
            CircularProgressIndicator(
                modifier = Modifier.size(Sizes.iconAction),
                strokeWidth = 2.dp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        return
    }
    if (message.isNullOrBlank()) return

    Text(
        text = message,
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        textAlign = TextAlign.Center,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = Spacing.xxl, vertical = Spacing.lg),
    )
}

/**
 * One person in a picker. `trailing` is whatever this particular picker does
 * about them: a checkmark, a spinner, or an Add button.
 *
 * The 56dp is a minimum rather than a height, so the row grows with the
 * reader's font-size setting instead of clipping the second line.
 */
@Composable
fun PersonRow(
    user: PublicUser,
    modifier: Modifier = Modifier,
    subtitle: String? = user.tag,
    trailing: @Composable () -> Unit = {},
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = Sizes.personRow)
            .padding(horizontal = Spacing.gutter, vertical = Spacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // Seeded by id, not by name: two people called "Ana" are two colours,
        // and one person who renames themselves keeps theirs.
        Avatar(
            name = user.displayName,
            url = user.avatarUrl,
            size = Sizes.avatarPerson,
            seed = user.id,
        )
        Spacer(Modifier.width(Spacing.md))
        Column(Modifier.weight(1f)) {
            Text(
                text = user.displayName,
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (!subtitle.isNullOrBlank()) {
                Text(
                    text = subtitle,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        trailing()
    }
}

private const val SEARCH_DEBOUNCE_MS = 300L
