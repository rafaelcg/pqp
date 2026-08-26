package gg.pqp.app.voice

/**
 * Which of two peers drives negotiation.
 *
 * **This has to agree with `isImpolite` in
 * `client/src/lib/peer-connection-manager.ts` exactly**, which is
 * `localPeerId > remotePeerId`: the peer whose id sorts *higher* is impolite
 * and sends the initial offer. Invert it and two peers either both offer
 * (glare) or neither does (a silent deadlock where everybody sits in
 * `connecting`), and it looks fine right up until two *different* clients meet
 * in one room, which is the case no single-client test covers.
 *
 * Kotlin's `String.compareTo` and JavaScript's `>` both compare UTF-16 code
 * units, so the two agree for any pair of peer ids the server mints.
 *
 * It lives in its own file, free of `org.webrtc` imports, for two reasons: the
 * rule was written out twice inside `VoiceEngine` and two copies of a rule are
 * two chances to invert one, and a JVM unit test can reach it without the
 * WebRTC native library being loadable. See `PolitenessTest`, which compares it
 * against the web client's source.
 */
fun isImpolite(localPeerId: String, remotePeerId: String): Boolean =
    localPeerId > remotePeerId
