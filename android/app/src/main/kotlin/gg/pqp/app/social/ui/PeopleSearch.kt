package gg.pqp.app.social.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
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

@Composable
fun PeopleSearchField(
    state: PeopleSearchState,
    modifier: Modifier = Modifier,
    tag: String = "people.search",
) {
    OutlinedTextField(
        value = state.query,
        onValueChange = { state.query = it.take(32) },
        modifier = modifier
            .fillMaxWidth()
            .testTag(tag),
        singleLine = true,
        leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
        placeholder = { Text(stringResource(R.string.people_search_hint)) },
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
        Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) {
            CircularProgressIndicator()
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
            .padding(horizontal = 32.dp, vertical = 16.dp),
    )
}

/**
 * One person in a picker. `trailing` is whatever this particular picker does
 * about them: a checkmark, a spinner, or an Add button.
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
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Avatar(name = user.displayName, url = user.avatarUrl, size = 44.dp)
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(
                text = user.displayName,
                style = MaterialTheme.typography.titleMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (!subtitle.isNullOrBlank()) {
                Text(
                    text = subtitle,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                )
            }
        }
        trailing()
    }
}

private const val SEARCH_DEBOUNCE_MS = 300L
