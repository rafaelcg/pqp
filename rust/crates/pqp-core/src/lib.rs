//! pqp core.
//!
//! The headless half of the client and server: the wire protocol, connection
//! state, and the credentials that survive a restart. No UI, no platform
//! calls, nothing that needs a display or a network stack to test.
//!
//! This is the shape Discord describes for its own client work: move the
//! protocols and the state down first, keep them provably equivalent to the
//! TypeScript they replace, and let whatever draws pixels sit on top. Every
//! test in this crate reads fixtures generated from the shipped TypeScript
//! rather than hand-written expectations, because an expectation written from
//! the port tests the port, not the product.

pub mod proto;
pub mod resume;

/// The media path a voice room runs on.
///
/// A property of the **room**, decided by the server, never a per-client
/// choice: two clients on different transports in one room cannot hear each
/// other at all, and nothing in either UI distinguishes that from someone
/// sitting there muted. That is why the transport is stated on the wire in
/// both directions rather than inferred.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VoiceRoomTransport {
    Mesh,
    Livekit,
}
