package gg.pqp.app.protocol

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * English and Portuguese, kept the same size.
 *
 * `docs/ANDROID.md` names this as a known gap: iOS has
 * `check-localization.py`, Android has no `.stringsdata` and therefore nothing
 * proving that a new `stringResource` call has a Portuguese counterpart. pt-BR
 * is the actual audience, so a half-translated screen is not a cosmetic
 * problem, and a missing key is invisible at build time (Android falls back to
 * English at runtime and says nothing).
 *
 * Deliberately a text comparison rather than an XML parse: what matters is the
 * set of `name` attributes and the `%s` slots inside them, and a parser would
 * be more machinery for the same answer.
 */
class LocalizationTest {

    private val english = File(RepoSources.root, "android/app/src/main/res/values/strings.xml")
    private val portuguese = File(RepoSources.root, "android/app/src/main/res/values-pt-rBR/strings.xml")

    private fun names(file: File): Set<String> =
        Regex("""<string\s+name="([^"]+)"""").findAll(file.readText()).map { it.groupValues[1] }.toSet()

    private fun strings(file: File): Map<String, String> =
        Regex("""<string\s+name="([^"]+)"[^>]*>(.*?)</string>""", RegexOption.DOT_MATCHES_ALL)
            .findAll(file.readText())
            .associate { it.groupValues[1] to it.groupValues[2] }

    @Test
    fun `both resource files are where they are expected to be`() {
        assertTrue("Missing ${english.path}", english.isFile)
        assertTrue("Missing ${portuguese.path}", portuguese.isFile)
        assertTrue("Parsed no strings out of the English file", names(english).size > 10)
    }

    @Test
    fun `every English string has a Portuguese counterpart`() {
        assertEquals(
            "Strings with no pt-BR translation. They fall back to English at runtime and " +
                "nothing says so; pt-BR is the audience this app is for.",
            emptySet<String>(),
            names(english) - names(portuguese),
        )
    }

    @Test
    fun `no Portuguese string has outlived its English original`() {
        assertEquals(
            "pt-BR strings that no longer exist in English, so nothing can reach them",
            emptySet<String>(),
            names(portuguese) - names(english),
        )
    }

    /**
     * A format slot that exists in one language and not the other is a
     * `MissingFormatArgumentException` at runtime, in the other language only.
     */
    @Test
    fun `the two languages agree about format slots`() {
        val en = strings(english)
        val pt = strings(portuguese)
        val slot = Regex("""%(\d+\$)?[sdf]""")

        val mismatched = en.keys.intersect(pt.keys).filter { name ->
            slot.findAll(en.getValue(name)).count() != slot.findAll(pt.getValue(name)).count()
        }
        assertEquals(
            "These strings have a different number of format slots in the two languages, " +
                "which crashes in whichever language has fewer.",
            emptyList<String>(),
            mismatched,
        )
    }

    private fun plurals(file: File): Set<String> =
        Regex("""<plurals\s+name="([^"]+)"""").findAll(file.readText()).map { it.groupValues[1] }.toSet()

    private fun pluralQuantities(file: File): Map<String, Set<String>> =
        Regex("""<plurals\s+name="([^"]+)"[^>]*>(.*?)</plurals>""", RegexOption.DOT_MATCHES_ALL)
            .findAll(file.readText())
            .associate { match ->
                match.groupValues[1] to
                    Regex("""quantity="(\w+)"""").findAll(match.groupValues[2])
                        .map { it.groupValues[1] }
                        .toSet()
            }

    /**
     * Plurals were invisible to every check above, and there are twelve of them.
     *
     * The three tests above parse `<string>` only, so a `<plurals>` added in
     * English with no Portuguese counterpart fell straight through: Android
     * falls back to the English form at runtime and says nothing, which is the
     * exact failure this file exists to make impossible for the other 315
     * strings. Found while adding the watch party's audience count, which is a
     * plural.
     */
    @Test
    fun `every English plural has a Portuguese counterpart`() {
        assertTrue("Parsed no plurals at all", plurals(english).isNotEmpty())
        assertEquals(
            "Plurals with no pt-BR translation. They fall back to English at runtime.",
            emptySet<String>(),
            plurals(english) - plurals(portuguese),
        )
        assertEquals(
            "pt-BR plurals that no longer exist in English",
            emptySet<String>(),
            plurals(portuguese) - plurals(english),
        )
    }

    /**
     * Portuguese may carry MORE quantities than English, never fewer.
     *
     * The asymmetry is CLDR's, not ours. English has `one` and `other`;
     * Brazilian Portuguese also has `many`, which is what makes "1 milhão de
     * pessoas" read correctly, and `dms_group_people` uses it. So the direction
     * that is a bug is a form English writes and Portuguese does not: that
     * count silently renders the English sentence. The other direction is a
     * translator doing their job.
     *
     * `other` is mandatory in both, because it is the form Android falls back
     * on when nothing else matches, and a plural without it is a
     * `Resources.NotFoundException` rather than a wrong word.
     */
    @Test
    fun `Portuguese carries every quantity English does`() {
        val en = pluralQuantities(english)
        val pt = pluralQuantities(portuguese)
        val missing = en.keys.intersect(pt.keys)
            .filter { (en.getValue(it) - pt.getValue(it)).isNotEmpty() }
        assertEquals(
            "These plurals have a form in English that pt-BR does not write, so that " +
                "count renders in English at runtime and nothing says so.",
            emptyList<String>(),
            missing,
        )
        assertEquals(
            "Every plural must carry `other`, the form Android falls back on",
            emptyList<String>(),
            (en + pt).filterValues { !it.contains("other") }.keys.toList(),
        )
    }

    /**
     * Every `R.string.x` in the Kotlin sources resolves.
     *
     * AGP catches this at compile time for the app, so this is mostly a guard
     * against a string being deleted from `values/` while a reference to it
     * survives in a branch nobody compiled. Cheap, and it also keeps the
     * unused-string direction honest.
     */
    @Test
    fun `every string the app references exists in English`() {
        val referenced = RepoSources.androidSources.values
            .flatMap { source ->
                Regex("""R\.string\.(\w+)""").findAll(source).map { it.groupValues[1] }.toList()
            }
            .toSet()
        assertTrue("Found no R.string references at all", referenced.isNotEmpty())
        assertEquals(
            "Referenced string resources that do not exist",
            emptySet<String>(),
            referenced - names(english),
        )
    }

    /**
     * `localeFilters` pins the APK to the two languages the product ships in,
     * so a dependency's forty other translations are dropped rather than
     * offered as a half-translated surface. Play reads the filter to build the
     * listing's language list.
     */
    @Test
    fun `the APK is still pinned to the two languages the store listing claims`() {
        val gradle = File(RepoSources.root, "android/app/build.gradle.kts").readText()
        assertTrue(
            "localeFilters no longer pins en and pt-rBR",
            Regex("""localeFilters\s*\+=\s*listOf\("en",\s*"pt-rBR"\)""").containsMatchIn(gradle),
        )
    }
}
