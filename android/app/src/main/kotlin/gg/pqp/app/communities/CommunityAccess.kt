package gg.pqp.app.communities

import gg.pqp.app.core.Permission
import gg.pqp.app.core.hasPermission

/**
 * What a server's public settings say and who may move them, as plain logic so
 * a JVM test can pin the rules the sheet draws.
 *
 * The rules are the server's (`PATCH /api/servers/:serverId/community` in
 * `server/src/api/index.ts`) and the web panel's
 * (`community-settings-section.tsx`). The server enforces them independently;
 * this exists so the sheet says WHY a switch is off before it is tapped instead
 * of as a refusal afterwards.
 */
object CommunityAccess {

    /** How open the room is right now, in the three words the sheet and the badge use. */
    enum class Visibility { Private, PublicLink, Listed, Suspended }

    fun visibility(settings: CommunitySettings): Visibility = when {
        !settings.isCommunity -> Visibility.Private
        // The operator pulled the page and the listing: the switches are still
        // on, but nobody can walk in, and saying otherwise would be a lie.
        settings.suspended -> Visibility.Suspended
        settings.listed -> Visibility.Listed
        else -> Visibility.PublicLink
    }

    /**
     * Whether this account sees the section at all: Manage Server, which the
     * owner holds (the server resolves OWNER to every bit before it sends them).
     * The route behind it is Manage Server too, so this is the same question
     * asked early, and a 403 from the sheet's read is still handled.
     */
    fun mayOpen(serverBits: Long): Boolean = hasPermission(serverBits, Permission.MANAGE_SERVER)

    /**
     * The same question from the server LIST, which holds a role word and no
     * bits. Only the two ranks that always carry Manage Server; a member with a
     * cargo that grants it gets the section from inside the server.
     */
    fun mayOpenFromRole(role: String?): Boolean = role == "owner" || role == "admin"

    /** Why a switch cannot be moved right now, or [Edit.Allowed]. */
    enum class Edit { Allowed, OwnerOnly, NeedsAddress, LockedByListing }

    /**
     * The address (Manage Server) is locked for a non-owner while the room is in
     * the directory: turning it off would take the listing down sideways, which
     * only the owner may do, and the server refuses exactly that.
     */
    fun addressEdit(isOwner: Boolean, settings: CommunitySettings): Edit =
        if (!isOwner && settings.listed) Edit.LockedByListing else Edit.Allowed

    /** The directory is the owner's alone, and impossible without an address. */
    fun listingEdit(isOwner: Boolean, settings: CommunitySettings): Edit = when {
        !isOwner -> Edit.OwnerOnly
        !settings.isCommunity -> Edit.NeedsAddress
        else -> Edit.Allowed
    }

    /** What a switch is being moved to. */
    enum class Change(val wire: (String?) -> UpdateCommunityBody, val opensDoor: Boolean) {
        AddressOn({ slug -> UpdateCommunityBody(isCommunity = true, slug = slug) }, opensDoor = true),
        AddressOff({ _ -> UpdateCommunityBody(isCommunity = false) }, opensDoor = false),
        ListingOn({ _ -> UpdateCommunityBody(isListed = true) }, opensDoor = true),
        ListingOff({ _ -> UpdateCommunityBody(isListed = false) }, opensDoor = false),
    }

    /**
     * Turning something ON asks first, because that is the direction that lets
     * strangers in. Turning it off asks nothing: closing a door needs no second
     * thought, and a confirmation there would only slow down undoing a mistake.
     */
    fun needsConfirmation(change: Change): Boolean = change.opensDoor

    /** A typed address is sent trimmed, and only when there is one. */
    fun cleanSlug(typed: String?): String? = typed?.trim()?.takeIf { it.isNotEmpty() }

    /** `pqp.gg/c/<slug>`, from the app URL with its scheme stripped, the web's display form. */
    fun displayAddress(slug: String, appUrl: String): String =
        appUrl.trimEnd('/').substringAfter("://") + "/c/" + slug

    /** The link that is copied: the whole URL, not the display form. */
    fun addressLink(slug: String, appUrl: String): String = appUrl.trimEnd('/') + "/c/" + slug

    /** Why a save failed, read from the status and the server's own sentence. */
    sealed interface Refusal {
        /** 409 on the address: another community holds it. The owner picks another. */
        data object SlugTaken : Refusal

        /** 422, or a 400 that says the address cannot be used. */
        data object SlugRejected : Refusal

        /** 409 on the directory: the address has to go on first. */
        data object NeedsAddress : Refusal

        /** 403: the server's own sentence says which of its two reasons applies. */
        data class Forbidden(val message: String?) : Refusal

        /** 404: communities are off here, or the server is gone. */
        data object Unavailable : Refusal

        data class Other(val message: String?) : Refusal
    }

    private val needsAddressSentence = Regex("public address on", RegexOption.IGNORE_CASE)
    private val addressUnusable = Regex("address cannot be used", RegexOption.IGNORE_CASE)

    /**
     * The web reads every 409 as a taken address. The directory's own 409
     * (address not on yet) is a different sentence the sheet can avoid
     * asking for, but when a stale screen does ask, it should not be told the
     * address is taken.
     */
    fun refusal(status: Int, serverMessage: String?): Refusal = when {
        status == 409 && serverMessage != null && needsAddressSentence.containsMatchIn(serverMessage) ->
            Refusal.NeedsAddress
        status == 409 -> Refusal.SlugTaken
        status == 422 -> Refusal.SlugRejected
        status == 400 && serverMessage != null && addressUnusable.containsMatchIn(serverMessage) ->
            Refusal.SlugRejected
        status == 403 -> Refusal.Forbidden(serverMessage)
        status == 404 -> Refusal.Unavailable
        else -> Refusal.Other(serverMessage)
    }

    /** A refusal that is about the address field, so the sheet shows the field. */
    fun isAddressRefusal(refusal: Refusal): Boolean =
        refusal == Refusal.SlugTaken || refusal == Refusal.SlugRejected
}
