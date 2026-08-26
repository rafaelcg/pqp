package gg.pqp.app.protocol

import java.io.File

/**
 * Reads the *other* clients' source as the source of truth.
 *
 * Every wire fact in this module is a hand-copy: each frame type string, the
 * politeness rule, the close codes, `DEV_AUTH_TOKEN`, the page ceiling, the
 * age-gate literals. Nothing generates them and nothing checks them, and a
 * `when` on a String ignores a *renamed* frame type exactly as quietly as an
 * unknown one. A test that asserted a Kotlin constant equals itself would pin
 * none of that.
 *
 * So these tests read the `packages/shared/src` schemas,
 * `server/src/ws/index.ts` and `client/src/lib/peer-connection-manager.ts`
 * off disk and compare against them. A protocol change on the server then
 * fails the Android build in CI, rather than being discovered as a message
 * that never renders.
 *
 * The cost is that the tests need the whole repo checked out, which is why
 * `.github/workflows/android.yml` triggers on the shared package and the
 * server's socket code as well as on the Android module. When the repo is
 * missing they fail loudly rather than skipping: a silently-skipped contract
 * test is worse than no test at all, because it still reads as green.
 */
object RepoSources {

    /**
     * Walks up from the Gradle test working directory (`android/app`) looking
     * for the pnpm workspace file, so the tests do not care how deeply the
     * checkout is nested or whether it is a git worktree.
     */
    val root: File by lazy {
        var candidate: File? = File("").absoluteFile
        while (candidate != null) {
            if (File(candidate, "pnpm-workspace.yaml").isFile) return@lazy candidate
            candidate = candidate.parentFile
        }
        error(
            "Could not find the pqp repo root above ${File("").absolutePath}. " +
                "These tests read packages/shared, server/ and client/ to pin the wire " +
                "contract, so they need the whole repo checked out, not just android/.",
        )
    }

    fun read(relativePath: String): String {
        val file = File(root, relativePath)
        check(file.isFile) { "Missing $relativePath under ${root.absolutePath}" }
        return file.readText()
    }

    /** Every Kotlin file the app actually ships, comments stripped. */
    val androidSources: Map<String, String> by lazy {
        File(root, "android/app/src/main/kotlin")
            .walkTopDown()
            .filter { it.isFile && it.extension == "kt" }
            .associate { it.name to stripComments(it.readText()) }
    }

    /**
     * Block comments go entirely; line comments only when the line is nothing
     * but a comment. Cutting at any `//` would also cut `"https://…"` and the
     * `/^\d{4}-…/` regex literals the zod schemas are full of.
     */
    fun stripComments(source: String): String =
        source
            .replace(Regex("/\\*.*?\\*/", RegexOption.DOT_MATCHES_ALL), "")
            .lineSequence()
            .filterNot { it.trimStart().startsWith("//") }
            .joinToString("\n")

    // --- reading zod ---

    /**
     * The `type` discriminant of every frame declared in a shared schema file.
     *
     * This is the set an Android `when` branch has to be a member of. A server
     * rename lands here first.
     */
    fun frameTypeLiterals(relativePath: String): Set<String> =
        Regex("""type:\s*z\.literal\("([^"]+)"\)""")
            .findAll(stripComments(read(relativePath)))
            .map { it.groupValues[1] }
            .toSet()

    fun enumValues(relativePath: String, schemaName: String): List<String> {
        val source = stripComments(read(relativePath))
        val match = Regex("""const\s+$schemaName\s*=\s*z\.enum\(\[([^\]]*)]""")
            .find(source)
            ?: error("No z.enum named $schemaName in $relativePath")
        return Regex(""""([^"]+)"""")
            .findAll(match.groupValues[1])
            .map { it.groupValues[1] }
            .toList()
    }

    fun numberConstant(relativePath: String, name: String): Int {
        val source = stripComments(read(relativePath))
        val match = Regex("""const\s+$name\s*=\s*(\d+)""").find(source)
            ?: error("No numeric constant $name in $relativePath")
        return match.groupValues[1].toInt()
    }

    fun stringConstant(relativePath: String, name: String): String {
        val source = stripComments(read(relativePath))
        val match = Regex("""const\s+$name\s*=\s*"([^"]*)"""").find(source)
            ?: error("No string constant $name in $relativePath")
        return match.groupValues[1]
    }

    /**
     * The top-level keys of a `z.object({...})`, in declaration order.
     *
     * Nesting is tracked by counting brackets rather than by parsing
     * TypeScript: a key is top level when the running depth is zero. That is
     * balanced enough for these files, and it fails loudly on a block it cannot
     * find the end of rather than returning a plausible-looking subset.
     */
    fun objectKeys(relativePath: String, schemaName: String): List<String> {
        val source = stripComments(read(relativePath))
        val start = Regex("""const\s+$schemaName\s*=\s*z\.object\(\{""").find(source)
            ?: error("No z.object named $schemaName in $relativePath")

        val keys = mutableListOf<String>()
        var depth = 0
        var closed = false
        for (line in source.substring(start.range.last + 1).lineSequence()) {
            if (depth == 0) {
                Regex("""^\s*(\w+)\s*:""").find(line)?.let { keys += it.groupValues[1] }
            }
            for (char in line) {
                when (char) {
                    '{', '[', '(' -> depth += 1
                    '}', ']', ')' -> depth -= 1
                    else -> Unit
                }
                if (depth < 0) {
                    closed = true
                    break
                }
            }
            if (closed) break
        }
        check(closed) { "Never found the end of $schemaName in $relativePath" }
        check(keys.isNotEmpty()) { "Parsed no keys out of $schemaName in $relativePath" }
        return keys
    }

    // --- reading Kotlin ---

    /** Frame types this client *sends*, from every `put("type", …)` site. */
    fun frameTypesSent(): Set<String> =
        androidSources.values.flatMap { source ->
            Regex("""put\("type",\s*"([a-z-]+)"\)""")
                .findAll(source)
                .map { it.groupValues[1] }
                .toList() +
                Regex(""""type"\s+to\s+"([a-z-]+)"""")
                    .findAll(source)
                    .map { it.groupValues[1] }
                    .toList()
        }.toSet()

    /**
     * Frame types this client *handles*, read out of the `when` blocks that
     * dispatch on a frame's `type`.
     *
     * Read from the source rather than from a list maintained next to it,
     * because a list maintained next to it is one more hand-copy and goes stale
     * the first time somebody adds a branch.
     */
    fun frameTypesHandled(): Set<String> =
        androidSources.values
            .flatMap { source -> whenOnTypeBlocks(source) }
            .flatMap { block ->
                Regex("""^\s*("[a-z-]+"(?:\s*,\s*"[a-z-]+")*)\s*->""", RegexOption.MULTILINE)
                    .findAll(block)
                    .flatMap { match ->
                        Regex(""""([a-z-]+)"""")
                            .findAll(match.groupValues[1])
                            .map { it.groupValues[1] }
                    }
                    .toList()
            }
            .toSet()

    private fun whenOnTypeBlocks(source: String): List<String> =
        Regex("""when\s*\([^)]*"type"[^{]*\{""")
            .findAll(source)
            .mapNotNull { match ->
                val open = source.lastIndexOf('{', match.range.last)
                if (open < 0) return@mapNotNull null
                var depth = 0
                for (index in open until source.length) {
                    when (source[index]) {
                        '{' -> depth += 1
                        '}' -> {
                            depth -= 1
                            if (depth == 0) return@mapNotNull source.substring(open + 1, index)
                        }
                        else -> Unit
                    }
                }
                null
            }
            .toList()
}
