package gg.pqp.app.voice

import gg.pqp.app.core.IceServer

/**
 * Which ICE servers an SFU (LiveKit) connection is handed, if any.
 *
 * The LiveKit server sends its own ICE list in the join response, and
 * [LiveKitEngine] used to connect with nothing else, ignoring the list
 * `/api/ice-servers` gave the join. On the hosted deployment the server's list
 * is the media box's built-in TURN (UDP on the box itself, plus a TLS relay on
 * a port Caddy owns, so dead), while the API's list carries the relays the
 * product pays for. The mesh path has used that list all along.
 *
 * What livekit-android 2.28.1 does with a client list (`RTCEngine.makeRTCConfig`,
 * read at tag v2.28.1): `ConnectOptions.iceServers` is only consulted when
 * `ConnectOptions.rtcConfig` is also given, it is appended to that config's
 * servers, and the join response's servers are used only when that merged list
 * is EMPTY. So in practice a non-empty client list REPLACES the server's, and
 * `iceServers` without `rtcConfig` is silently ignored. A list without a relay
 * would therefore be worse than today, which is why this returns an empty list,
 * meaning "pass nothing, keep the server's list", unless the API's list carries
 * at least one TURN entry. The web (`sfu-ice-servers.ts`) and iOS
 * (`SfuIceServers.swift`) apply the same rule.
 */
fun sfuIceServers(ice: List<IceServer>): List<IceServer> {
    val hasRelay = ice.any { server -> server.urlList.any(::isTurnUrl) }
    return if (hasRelay) ice.toList() else emptyList()
}

fun isTurnUrl(url: String): Boolean {
    val scheme = url.trim().lowercase()
    return scheme.startsWith("turn:") || scheme.startsWith("turns:")
}
