package gg.pqp.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * URL joining, which is the reason avatars either load or do not.
 *
 * Several fields on the wire are root-relative (`/api/avatars/…`,
 * `/api/servers/:id/icon`) and attachment URLs are presigned absolutes. One
 * helper decides which it is holding, and getting it wrong produces
 * `https://api.pqp.gghttps://…` — a broken image with no error anywhere.
 */
class BackendTest {

    @Test
    fun `an absolute URL is left alone`() {
        val presigned = "https://pqp.r2.cloudflarestorage.com/x?X-Amz-Signature=abc"
        assertEquals(presigned, Backend.absolute(presigned))
        assertEquals("http://example.test/x", Backend.absolute("http://example.test/x"))
    }

    @Test
    fun `a root-relative path is joined to the API origin`() {
        assertEquals("${Backend.apiUrl}/api/avatars/u1", Backend.absolute("/api/avatars/u1"))
    }

    @Test
    fun `a bare path gets exactly one slash`() {
        assertEquals("${Backend.apiUrl}/api/avatars/u1", Backend.absolute("api/avatars/u1"))
    }

    @Test
    fun `nothing in means nothing out`() {
        assertNull(Backend.absolute(null))
        assertNull(Backend.absolute(""))
        assertNull(Backend.absolute("   "))
    }

    /**
     * The trailing slash is stripped once, at the source, so no call site has
     * to think about it.
     */
    @Test
    fun `the API base carries no trailing slash`() {
        assert(!Backend.apiUrl.endsWith("/")) { Backend.apiUrl }
    }

    /**
     * Clerk when a key is present, otherwise the dev bypass. Stated this way
     * round on purpose: a release build with no key must be loudly unable to
     * authenticate rather than quietly falling back to a token only a local
     * server accepts.
     */
    @Test
    fun `no publishable key means the dev bypass, not a silent Clerk attempt`() {
        val expected = if (Backend.clerkPublishableKey == null) AuthMode.DevBypass else AuthMode.Clerk
        assertEquals(expected, Backend.authMode)
    }
}
