package gg.pqp.app.voice.telecom

import android.content.ComponentName
import android.content.Context
import android.net.Uri
import android.os.Bundle
import android.telecom.PhoneAccount
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import android.util.Log
import gg.pqp.app.R

/**
 * The Telecom-facing half of this feature: everything [TelecomController]
 * asks for that only `android.telecom` can do.
 *
 * An interface for the same reason [gg.pqp.app.voice.VoiceTransport] is one:
 * the thing behind it needs a live system service no JVM test can build, so
 * the decisions ([TelecomCoordinator]) are pinned by tests that hand this
 * interface a fake, and this real implementation is verified by reading and,
 * where noted, on a device.
 */
interface TelecomGateway {
    /**
     * Register this app's self-managed [PhoneAccount] with Telecom.
     *
     * Idempotent and best-effort. A registration Telecom refuses (no
     * `MANAGE_OWN_CALLS`, a device policy that disables it, an OEM that does
     * not implement self-managed accounts fully) leaves [isReady] false and
     * every other method a safe no-op: this feature is additive to a call
     * that already works without it.
     */
    fun ensureRegistered()

    /** Whether Telecom answers to the registered account at all. Checked
     * before every placed or incoming call, because a refusal can arrive
     * later than registration (an account can be disabled from Settings). */
    val isReady: Boolean

    fun placeCall(roomId: String, address: String, displayName: String)
    fun addIncomingCall(roomId: String, address: String, displayName: String)
    fun markAnswered(roomId: String)

    /** The room's media is actually up (`VoiceStage.Connected`), so Telecom's
     * own record of the call should stop saying "Dialing". Idempotent: safe
     * to call on a connection that is already active. */
    fun markActive(roomId: String)
    fun endConnection(roomId: String, cause: TelecomEndCause)
}

/**
 * The real [TelecomGateway], built on `TelecomManager` and the connections
 * [PqpConnectionService] hands to [TelecomBridge] when the system asks it to
 * build one.
 *
 * Every call into `TelecomManager` is wrapped: Telecom can refuse for
 * reasons this client cannot enumerate (a disabled account, a device that
 * caps concurrent self-managed calls, a restricted profile), and refusing is
 * supposed to look like "Telecom does not exist" — the call still goes
 * through on `VoiceController`/`CallController`, exactly as it did before
 * this feature shipped. A dead call because Telecom said no would be a
 * regression this exists to prevent, not one it is allowed to cause.
 */
class AndroidTelecomGateway(private val context: Context) : TelecomGateway {

    private val telecomManager: TelecomManager? =
        context.getSystemService(Context.TELECOM_SERVICE) as? TelecomManager

    private val handle: PhoneAccountHandle =
        PhoneAccountHandle(ComponentName(context, PqpConnectionService::class.java), ACCOUNT_ID)

    @Suppress("DEPRECATION")
    override fun ensureRegistered() {
        val manager = telecomManager ?: return
        runCatching {
            val account = PhoneAccount.builder(handle, context.getString(R.string.app_name))
                .setCapabilities(PhoneAccount.CAPABILITY_SELF_MANAGED)
                .setShortDescription(context.getString(R.string.app_name))
                .build()
            manager.registerPhoneAccount(account)
        }.onFailure { Log.w(TAG, "phone account registration refused: ${it.message}") }
    }

    override val isReady: Boolean
        get() {
            val manager = telecomManager ?: return false
            return runCatching { manager.getPhoneAccount(handle)?.isEnabled == true }.getOrDefault(false)
        }

    /**
     * `TelecomManager.placeCall` is annotated `@RequiresPermission(anyOf =
     * [CALL_PHONE, ...])` for the general case of a real phone call, which is
     * a permission this app never requests. A self-managed account is exempt
     * — `MANAGE_OWN_CALLS` (declared in the manifest, a normal permission) is
     * what actually gates this call for an app in our position — but lint
     * has no way to know that from the annotation alone, and the `runCatching`
     * below is the real handling of a refusal lint is asking for.
     */
    @android.annotation.SuppressLint("MissingPermission")
    override fun placeCall(roomId: String, address: String, displayName: String) {
        val manager = telecomManager ?: return
        if (!isReady) return
        runCatching {
            manager.placeCall(
                roomUri(address),
                Bundle().apply {
                    putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, handle)
                    putString(EXTRA_ROOM_ID, roomId)
                    putString(EXTRA_DISPLAY_NAME, displayName)
                },
            )
        }.onFailure { Log.w(TAG, "placeCall refused for $roomId: ${it.message}") }
    }

    override fun addIncomingCall(roomId: String, address: String, displayName: String) {
        val manager = telecomManager ?: return
        if (!isReady) return
        runCatching {
            manager.addNewIncomingCall(
                handle,
                Bundle().apply {
                    putParcelable(TelecomManager.EXTRA_INCOMING_CALL_ADDRESS, roomUri(address))
                    putString(EXTRA_ROOM_ID, roomId)
                    putString(EXTRA_DISPLAY_NAME, displayName)
                },
            )
        }.onFailure { Log.w(TAG, "addNewIncomingCall refused for $roomId: ${it.message}") }
    }

    override fun markAnswered(roomId: String) {
        IncomingCallNotifier.cancel(context, roomId)
        markActive(roomId)
    }

    override fun markActive(roomId: String) {
        val connection = TelecomBridge.find(roomId)
        if (connection == null) {
            // The system has not finished creating this room's connection
            // yet (placeCall/addNewIncomingCall already returned, but
            // PqpConnectionService has not been called back into). Queue
            // it: TelecomBridge.register replays this the moment the
            // connection actually exists, instead of the call silently
            // staying "Dialing" forever (Farol review, PR 678).
            TelecomBridge.queueActive(roomId)
            return
        }
        runCatching { connection.setActive() }
    }

    override fun endConnection(roomId: String, cause: TelecomEndCause) {
        IncomingCallNotifier.cancel(context, roomId)
        val causeCode = disconnectCauseCode(cause)
        val connection = TelecomBridge.find(roomId)
        if (connection == null) {
            // Same race as markActive, the other direction: the room ended
            // (or the ring did) before its connection was registered. Queue
            // the end so a connection that gets created moments later is
            // torn down immediately instead of lingering as a ghost call
            // (Farol review, PR 678).
            TelecomBridge.queueEnd(roomId, causeCode)
            return
        }
        runCatching { connection.end(causeCode) }
    }

    private fun roomUri(address: String): Uri = Uri.fromParts(ADDRESS_SCHEME, address, null)

    private fun disconnectCauseCode(cause: TelecomEndCause): Int = when (cause) {
        TelecomEndCause.Missed -> android.telecom.DisconnectCause.MISSED
        TelecomEndCause.Rejected -> android.telecom.DisconnectCause.REJECTED
        TelecomEndCause.Local -> android.telecom.DisconnectCause.LOCAL
        TelecomEndCause.Error -> android.telecom.DisconnectCause.ERROR
    }

    companion object {
        private const val TAG = "pqp.telecom"
        private const val ACCOUNT_ID = "pqp"

        /** Not `tel:`: this account carries no telephone numbers, and a
         * self-managed address only has to be a stable string. */
        const val ADDRESS_SCHEME = "pqp"

        const val EXTRA_ROOM_ID = "gg.pqp.app.ROOM_ID"
        const val EXTRA_DISPLAY_NAME = "gg.pqp.app.DISPLAY_NAME"
    }
}
