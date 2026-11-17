package gg.pqp.app.activities

import gg.pqp.app.activities.bridge.ActivityTheme
import gg.pqp.app.activities.bridge.applyMergePatch
import gg.pqp.app.activities.bridge.jsonByteLength
import gg.pqp.app.activities.bridge.jsonProblem
import gg.pqp.app.activities.bridge.stateBytesAfter
import gg.pqp.app.activities.bridge.TokenBucket
import gg.pqp.app.activities.web.ActivityHostPage
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The page that frames an app, the origin rule that keeps every fetch on the apps origin,
 * and the small pure pieces the bridge is built from.
 */
class ActivityHostPageTest {

    private fun page(entry: String = "http://localhost:5175/pqp-eco/1.0.2/index.html", title: String = "Eco") =
        ActivityHostPage.html(entry, "http://localhost:5175", "abc123", title, "#090e12")

    @Test
    fun `the frame is sandboxed with scripts only and no permissions`() {
        val html = page()
        assertTrue(html.contains("""iframe.setAttribute("sandbox", "allow-scripts")"""))
        assertFalse("never the same origin as this page", html.contains("allow-same-origin"))
        assertFalse(html.contains("allow-top-navigation"))
        assertFalse(html.contains("allow-popups"))
        assertTrue(html.contains("""iframe.setAttribute("allow", "")"""))
        assertTrue(html.contains("""iframe.setAttribute("referrerpolicy", "no-referrer")"""))
    }

    @Test
    fun `the page carries a policy that frames the apps origin and nothing else`() {
        val html = page()
        val csp = Regex("""Content-Security-Policy" content="([^"]+)"""").find(html)!!.groupValues[1]
        assertTrue(csp.contains("default-src 'none'"))
        assertTrue(csp.contains("frame-src http://localhost:5175;"))
        assertTrue(csp.contains("connect-src 'none'"))
        assertTrue(csp.contains("script-src 'nonce-abc123'"))
        assertFalse(csp.contains("unsafe-inline"))
        assertFalse(csp.contains("*"))
    }

    @Test
    fun `no javascript interface is used, the native port is only taken from a message with no source`() {
        val html = page()
        assertFalse(html.contains("addJavascriptInterface"))
        assertTrue(html.contains("""e.source === null && e.data === "${ActivityHostPage.NATIVE_HELLO}""""))
        // the frame's hello is answered only from the frame's own window, and only once
        assertTrue(html.contains("e.source === iframe.contentWindow"))
        assertTrue(html.contains("if (helloSeen || !isHello(e.data)) return;"))
    }

    @Test
    fun `the requests a phone has no answer for are answered by the page and never reach kotlin`() {
        val html = page()
        for ((type, code) in ActivityHostPage.ANSWERED_HERE) {
            assertTrue(type, html.contains("\"$type\":\"$code\""))
        }
        assertEquals("a share is not allowed on a phone, the rest are not there", "not-allowed", ActivityHostPage.ANSWERED_HERE["share.audio"])
        assertEquals("unavailable", ActivityHostPage.ANSWERED_HERE["store.put"])
    }

    @Test
    fun `when the session is over the page closes the app's port and takes the frame out`() {
        val html = page()
        val remove = html.substringAfter("""if (data === "${ActivityHostPage.CONTROL_REMOVE}") {""").substringBefore("return;")
        assertTrue("the app's port is closed", remove.contains("appPort.close()"))
        assertTrue("and no longer listened to", remove.contains("appPort.onmessage = null"))
        assertTrue("and the frame is removed from the page", remove.contains("removeChild(iframe)"))
    }

    @Test
    fun `a string put in the page cannot leave its literal`() {
        val nasty = "\"; alert(1); //</script><img src=x onerror=1> \n\\"
        val literal = ActivityHostPage.js(nasty)
        assertFalse(literal.contains("</script"))
        assertFalse(literal.contains("<"))
        assertFalse(literal.contains("\n"))
        assertFalse(literal.contains(" "))
        // and it reads back as the same text
        assertEquals(nasty, Json.parseToJsonElement(literal.replace("\\u2028", " ")).let { (it as JsonPrimitive).content })
        val html = page(entry = "http://localhost:5175/x\";alert(1)//", title = "</script><b>")
        assertFalse(html.contains("</script><b>"))
        assertEquals("one script, closed once", 1, Regex("</script>").findAll(html).count())
    }

    @Test
    fun `a url is on the origin only when scheme host and port all match`() {
        val origin = "https://pqp-apps.pages.dev"
        assertTrue(ActivityHostPage.isOnOrigin("https://pqp-apps.pages.dev/pqp-eco/1.0.2/index.html", origin))
        assertTrue(ActivityHostPage.isOnOrigin("https://PQP-APPS.pages.dev:443/x", origin))
        assertFalse(ActivityHostPage.isOnOrigin("https://pqp-apps.pages.dev.evil.example/x", origin))
        assertFalse(ActivityHostPage.isOnOrigin("https://evil.example/https://pqp-apps.pages.dev", origin))
        assertFalse(ActivityHostPage.isOnOrigin("http://pqp-apps.pages.dev/x", origin))
        assertFalse(ActivityHostPage.isOnOrigin("https://pqp-apps.pages.dev:8443/x", origin))
        assertFalse(ActivityHostPage.isOnOrigin("data:text/html,hi", origin))
        assertFalse(ActivityHostPage.isOnOrigin("not a url", origin))
        assertTrue(ActivityHostPage.isOnOrigin("http://localhost:5175/a", "http://localhost:5175"))
        assertFalse(ActivityHostPage.isOnOrigin("http://localhost:5176/a", "http://localhost:5175"))
    }

    // --- merge patch and sizes ---

    @Test
    fun `merge patch follows RFC 7396`() {
        val target = Json.parseToJsonElement("""{"a":"b","c":{"d":"e","f":"g"},"x":[1,2]}""")
        val patch = Json.parseToJsonElement("""{"a":"z","c":{"f":null},"x":[3]}""")
        assertEquals(Json.parseToJsonElement("""{"a":"z","c":{"d":"e"},"x":[3]}"""), applyMergePatch(target, patch))
        assertEquals("a non-object patch replaces the target", JsonPrimitive(3), applyMergePatch(target, JsonPrimitive(3)))
        assertEquals(Json.parseToJsonElement("""{"a":1}"""), applyMergePatch(JsonNull, Json.parseToJsonElement("""{"a":1}""")))
        assertEquals("a key named __proto__ is an ordinary key", Json.parseToJsonElement("""{"__proto__":1}"""),
            applyMergePatch(JsonNull, Json.parseToJsonElement("""{"__proto__":1}""")))
    }

    @Test
    fun `sizes are compact utf-8 bytes of the merged value`() {
        assertEquals(2, jsonByteLength(buildJsonObject { }))
        assertEquals(7, jsonByteLength(buildJsonObject { put("a", 1) })) // {"a":1}
        assertEquals(jsonByteLength(JsonPrimitive("é")), 4) // "é" is two bytes plus the quotes
        val grown = stateBytesAfter(buildJsonObject { put("a", "xx") }, buildJsonObject { put("b", "yy") })
        assertEquals(jsonByteLength(Json.parseToJsonElement("""{"a":"xx","b":"yy"}""")), grown)
    }

    @Test
    fun `a value deeper than 32 levels or holding a null character is not acceptable`() {
        var deep: kotlinx.serialization.json.JsonElement = JsonPrimitive(1)
        repeat(40) { deep = JsonArray(listOf(deep)) }
        assertNotNull(jsonProblem(deep))
        assertNull(jsonProblem(buildJsonArray { add(JsonPrimitive("fine")) }))
        assertNotNull(jsonProblem(JsonPrimitive("a\u0000b")))
        assertNotNull(jsonProblem(buildJsonObject { put("k\u0000", 1) }))
    }

    @Test
    fun `a token bucket refills with time and zero refuses everything`() {
        var t = 0L
        val bucket = TokenBucket(2.0, 2) { t }
        assertTrue(bucket.take())
        assertTrue(bucket.take())
        assertFalse(bucket.take())
        t += 500
        assertTrue(bucket.take())
        assertFalse(bucket.take())
        val none = TokenBucket(0.0, 1) { t }
        assertTrue("the burst is still one", none.take())
        t += 10_000
        assertFalse(none.take())
    }

    // --- theme ---

    @Test
    fun `the theme is the allowlist of design tokens, as hex, with the scheme`() {
        val dark = ActivityTheme.Palette(
            dark = true, background = 0xFF090E12.toInt(), surface = 0xFF12181D.toInt(), surfaceRaised = 0xFF1C2329.toInt(),
            chrome = 0xFF05080C.toInt(), border = 0xFF2B343C.toInt(), onSurface = 0xFFF0EEE8.toInt(),
            onSurfaceVariant = 0xFFB6B4AF.toInt(), primary = 0xFFBBEC4C.toInt(), primaryHover = 0xFF92BF35.toInt(),
            onPrimary = 0xFF05080C.toInt(), danger = 0xFFEF5350.toInt(), onDanger = 0xFF05080C.toInt(),
            warning = 0xFFF9BF49.toInt(), success = 0xFF66D475.toInt(),
        )
        val tokens = ActivityTheme.tokens(dark)
        assertEquals("#bbec4c", tokens["--color-accent"])
        assertEquals("#090e12", tokens["--color-surface-0"])
        assertEquals("dark", tokens[ActivityTheme.COLOR_SCHEME_TOKEN])
        assertEquals("light", ActivityTheme.tokens(dark.copy(dark = false))[ActivityTheme.COLOR_SCHEME_TOKEN])
        assertTrue(tokens.size <= 64)
        assertTrue(tokens.values.all { it.length <= 256 })
        assertTrue(tokens.keys.all { Regex("^--[A-Za-z0-9_-]{1,64}$").matches(it) })
        // a soft fill is the accent laid over the page, not a transparent value the frame would paint wrongly
        assertTrue(Regex("^#[0-9a-f]{6}$").matches(tokens["--color-accent-soft"]!!))
    }
}
