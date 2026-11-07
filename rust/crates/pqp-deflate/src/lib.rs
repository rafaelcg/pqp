//! `permessage-deflate` (RFC 7692) as this server actually negotiates it.
//!
//! Why this crate exists: no mainstream Rust WebSocket stack implements the
//! extension (`docs/RUST.md`, "Whether a Rust gateway can negotiate
//! `permessage-deflate` at all"), and a gateway that quietly declines it ships
//! 5.2x the roster bytes with nothing in the logs to say so. The peer on the
//! other side is `ws` 8.21, so the framing here is copied from
//! `node_modules/.pnpm/ws@8.21.0/node_modules/ws/lib/permessage-deflate.js`
//! rather than from the RFC alone, because the RFC leaves the details that
//! break interop open:
//!
//! * one raw-deflate stream per direction for the life of the connection, NOT
//!   one per message -- reset at each message end only when
//!   `no_context_takeover` is negotiated, which the shipped policy does in both
//!   directions, so the stream is short-lived here even though it is allocated
//!   once;
//! * each message ends with a `Z_SYNC_FLUSH`, whose trailing `00 00 ff ff` is
//!   **trimmed from the last fragment** on the way out and **appended to the
//!   last fragment** on the way in;
//! * `no_context_takeover` resets that stream when a message ends;
//! * window bits come from the negotiated parameters, defaulting to zlib's 15
//!   when the peer named none.
//!
//! Compression is deliberately not byte-for-byte comparable with Node. The
//! outbound stream is `zlib-rs` driven directly and the inbound stream is
//! `flate2` on the same backend (see `Cargo.toml` for why the backend is
//! load-bearing rather than cosmetic); Node runs zlib. Two deflate
//! implementations legitimately emit different bytes that inflate to the same
//! text. So the parity tests cross-decode: whatever Node compresses, this must
//! inflate, and whatever this compresses, Node must inflate. A test that
//! demanded identical bytes would be testing the choice of zlib fork.
//! Negotiation, by contrast, IS byte-compared, because the
//! `Sec-WebSocket-Extensions` response is a string both sides act on.
//!
//! THE PART THAT COSTS MEMORY, MEASURED RATHER THAN QUOTED.
//!
//! `server/src/lib/ws-compression.ts:50` picks `memLevel: 6` over zlib's default
//! 8 for a 0.4% worse ratio, and says the per-socket context drops from 256 KB
//! to 160 KB. `flate2` cannot make that choice: its zlib-rs backend builds the
//! config from level, header and window only (`flate2-1.1.11/src/ffi/zlib_rs.rs:221`),
//! and the three-argument constructor it calls takes `mem_level` from
//! `DeflateConfig::default()`, which is 8 (`zlib-rs-0.6.8/src/stable.rs:297`).
//! The backend does honour the number when a caller passes one
//! (`zlib-rs-0.6.8/src/deflate.rs:321` sizes `lit_bufsize` as `1 << (mem_level + 6)`),
//! so this crate drives `zlib-rs` directly on the outbound side and
//! [`Params::mem_level`] is acted on.
//!
//! What it is actually worth is smaller than zlib's arithmetic suggests, and the
//! measured number is the one to quote: 48 KiB per socket, 48 MB across a
//! thousand, at an unchanged ratio (`tests/memory.rs`). The reason is that the
//! only allocation `mem_level` scales here is the symbol buffer, so the 256/160
//! split that Node's zlib reports does not transfer. The same probe puts this
//! backend at 289 KiB of deflate state per socket at `memLevel` 6, which is more
//! than the 160 KB the shipped policy reports: a Rust gateway is not a memory win
//! on this axis, and `docs/RUST.md` carries that instead of a slogan.

use base64::Engine as _;
use flate2::{Decompress, FlushDecompress};
use std::fmt;
use zlib_rs::{Deflate, DeflateConfig, DeflateFlush, Method, Strategy};

/// The four bytes zlib's `Z_SYNC_FLUSH` appends and RFC 7692 §7.2.1 trims.
const TRAILER: [u8; 4] = [0x00, 0x00, 0xff, 0xff];

/// zlib's default when a peer names no window: 32 KiB of history.
pub const DEFAULT_WINDOW_BITS: u8 = 15;

/// Everything about the extension that both sides have to agree on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Params {
    /// Deflate level, 0..=9. The server ships 3; see `ws-compression.ts:47`.
    pub level: u8,
    /// zlib memLevel. Recorded, not honoured — see the crate docs.
    pub mem_level: u8,
    /// Window the *peer* may use when compressing to us, if it named one.
    pub client_max_window_bits: Option<u8>,
    /// Window *we* may use when compressing to the peer, if we offered one.
    pub server_max_window_bits: Option<u8>,
    /// Drop the peer's dictionary after each message it sends.
    pub client_no_context_takeover: bool,
    /// Drop our dictionary after each message we send.
    pub server_no_context_takeover: bool,
    /// Refuse a decompressed message larger than this. A compressed frame of a
    /// few kilobytes can expand by orders of magnitude, and a gateway that
    /// inflates without a ceiling turns a client into a denial of service.
    pub max_decompressed_bytes: usize,
}

impl Default for Params {
    /// Nothing negotiated: zlib's own defaults, which means context takeover ON
    /// at both ends and a 32 KiB window. A connection that has been negotiated
    /// gets its parameters from [`Policy::accept`], not from here; this is the
    /// starting point that function edits, and what unit tests use when they are
    /// about the stream rather than about the handshake.
    fn default() -> Self {
        Self {
            level: 3,
            mem_level: 6,
            client_max_window_bits: None,
            server_max_window_bits: None,
            client_no_context_takeover: false,
            server_no_context_takeover: false,
            max_decompressed_bytes: 1 << 20,
        }
    }
}

impl Params {
    /// Whether `mem_level` reaches the backend.
    ///
    /// True, and checked by `tests/memory.rs`, which measures a socket opened at
    /// `memLevel` 6 against one opened at 8 in the same process. It was false
    /// while the outbound stream went through `flate2`, which has no way to pass
    /// the parameter; the function stays because a caller should not have to read
    /// the dependency graph to know whether their setting did anything.
    pub fn mem_level_is_honoured(&self) -> bool {
        true
    }

    /// Window bits the inbound (peer-to-us) inflate is opened with.
    pub fn inbound_window_bits(&self) -> u8 {
        self.client_max_window_bits.unwrap_or(DEFAULT_WINDOW_BITS)
    }

    /// Window bits the outbound (us-to-peer) deflate is opened with.
    pub fn outbound_window_bits(&self) -> u8 {
        self.server_max_window_bits.unwrap_or(DEFAULT_WINDOW_BITS)
    }
}

/// Anything that kept this extension from being agreed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NegotiationError {
    /// No offer in the header can be met by this policy. `ws` throws
    /// `None of the extension offers can be accepted` and answers HTTP 400, so
    /// this is a refused connection rather than a connection without
    /// compression -- and pinning a window-bits number is exactly how it ends up
    /// with a login screen that never loads for four of the five stacks that
    /// connect (`ws-compression.ts:20`). Under [`Policy::default`] no offer is
    /// ever rejected for this reason, which is the point of that default.
    UnacceptableParameter(&'static str),
    /// A window-bits value outside 8..=15, which RFC 7692 §7.1.2.1 forbids.
    WindowBitsOutOfRange(u8),
    /// A window-bits value that is not a number at all.
    MalformedValue { name: &'static str, value: String },
    /// A parameter the peer sent that neither side has a meaning for.
    UnknownParameter(String),
    /// The same parameter twice, which `ws` also refuses.
    DuplicateParameter(&'static str),
}

impl fmt::Display for NegotiationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnacceptableParameter(p) => {
                write!(f, "peer did not offer the parameter `{p}` we require")
            }
            Self::WindowBitsOutOfRange(v) => {
                write!(f, "window bits {v} is outside the 8..=15 the RFC allows")
            }
            Self::MalformedValue { name, value } => {
                write!(f, "invalid value for parameter \"{name}\": {value}")
            }
            Self::UnknownParameter(name) => write!(f, "unknown parameter \"{name}\""),
            Self::DuplicateParameter(name) => {
                write!(f, "parameter \"{name}\" was offered more than once")
            }
        }
    }
}

impl std::error::Error for NegotiationError {}

/// One extension parameter, `name` with an optional `=value`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Parameter {
    pub name: String,
    pub value: Option<String>,
}

/// Parse one `Sec-WebSocket-Extensions` value into its extension lines and
/// their parameters. Quoted values are unquoted; nothing else is interpreted.
pub fn parse_extensions(header: &str) -> Vec<Vec<Parameter>> {
    // A header value is a comma-separated list of extension lines, each a
    // semicolon-separated list of parameters. Commas inside a quoted string
    // belong to the parameter, so quotes are tracked by hand.
    let mut lines: Vec<Vec<Parameter>> = Vec::new();
    let mut current: Vec<Parameter> = Vec::new();
    let mut token = String::new();
    let mut quoted = false;
    let mut escaped = false;
    let push_token = |token: &mut String, current: &mut Vec<Parameter>| {
        let trimmed = token.trim();
        if !trimmed.is_empty() {
            let (name, value) = match trimmed.split_once('=') {
                Some((n, v)) => (
                    n.trim().to_ascii_lowercase(),
                    Some(v.trim().trim_matches('"').to_string()),
                ),
                None => (trimmed.to_ascii_lowercase(), None),
            };
            current.push(Parameter { name, value });
        }
        token.clear();
    };
    for ch in header.chars() {
        match ch {
            '\\' if quoted => {
                escaped = !escaped;
                if !escaped {
                    token.pop();
                }
                token.push(ch);
            }
            '"' => {
                quoted = !quoted;
                token.push(ch);
            }
            ',' if !quoted => {
                push_token(&mut token, &mut current);
                if !current.is_empty() {
                    lines.push(std::mem::take(&mut current));
                }
            }
            ';' if !quoted => {
                push_token(&mut token, &mut current);
            }
            _ => token.push(ch),
        }
    }
    push_token(&mut token, &mut current);
    if !current.is_empty() {
        lines.push(current);
    }
    lines
}

/// What the server asks for, mirrored from `WS_PER_MESSAGE_DEFLATE`
/// (`server/src/lib/ws-compression.ts`).
///
/// `ws`'s `acceptAsServer` writes these into the response from the SERVER's
/// options whether or not the peer mentioned them (`permessage-deflate.js:182`).
/// A negotiation that only reads the offer therefore answers with a different
/// `Sec-WebSocket-Extensions` value than the server it replaces -- still a
/// working connection, but with context takeover on, which is the per-socket
/// window growth the shipped policy exists to bound. The fixtures in
/// `fixtures/deflate-vectors.json` are what caught that: `ws` answers every
/// bare offer with
/// `permessage-deflate; server_no_context_takeover; client_no_context_takeover`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Policy {
    /// Deflate level to hand the backend.
    pub level: u8,
    /// Recorded, not honoured. See [`Params::mem_level_is_honoured`].
    pub mem_level: u8,
    /// Ask the peer to drop its dictionary after each message it sends.
    pub client_no_context_takeover: bool,
    /// Drop our dictionary after each message we send.
    pub server_no_context_takeover: bool,
    /// A number here is named back to the peer in the response. `None` -- the
    /// shipped setting -- honours whatever window the peer offered, or 15.
    ///
    /// `ws` has a third possibility, `false`, meaning "refuse to be told a
    /// smaller window"; it is not modelled because the shipped policy does not
    /// use it, and a setting nothing sets is a place for a bug to live.
    pub server_max_window_bits: Option<u8>,
    /// Same, for the window the peer must use. `None` accepts any offer.
    pub client_max_window_bits: Option<u8>,
    /// Ceiling on one decompressed message.
    pub max_decompressed_bytes: usize,
}

impl Default for Policy {
    /// The shipped policy, so `Policy::default()` and the server agree by
    /// construction rather than by comment.
    fn default() -> Self {
        Self {
            level: 3,
            mem_level: 6,
            client_no_context_takeover: true,
            server_no_context_takeover: true,
            server_max_window_bits: None,
            client_max_window_bits: None,
            max_decompressed_bytes: 1 << 20,
        }
    }
}

/// A negotiated parameter value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Value {
    /// Valueless flag: a `*_no_context_takeover`, or `client_max_window_bits`
    /// with no `=value` -- which Chromium sends and means "15 is fine".
    Flag,
    Number(u8),
}

/// The four parameters `ws` knows. Anything else is refused, like it is there.
const KNOWN: [&str; 4] = [
    "client_max_window_bits",
    "client_no_context_takeover",
    "server_max_window_bits",
    "server_no_context_takeover",
];

/// One offer from the peer, with its parameters in the order it sent them.
///
/// Order is part of the contract: `ws` builds the response string from the
/// accepted parameter object (`extension.format`), so the accepted offer's
/// parameters come first and the server's own asks are appended. Reordering the
/// same set produces a different byte string, which is what the parity test
/// compares.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Offer {
    params: Vec<(&'static str, Value)>,
}

impl Offer {
    fn number(&self, name: &str) -> Option<u8> {
        self.params.iter().find_map(|(n, v)| {
            if *n == name {
                if let Value::Number(x) = *v {
                    return Some(x);
                }
            }
            None
        })
    }

    fn has(&self, name: &str) -> bool {
        self.params.iter().any(|(n, _)| *n == name)
    }

    /// Set a parameter the way a JS assignment does: in place if the object
    /// already has the key, appended at the end if it does not.
    fn put(&mut self, name: &'static str, value: Value) {
        match self.params.iter_mut().find(|(n, _)| *n == name) {
            Some(slot) => slot.1 = value,
            None => self.params.push((name, value)),
        }
    }

    fn remove(&mut self, name: &str) {
        self.params.retain(|(n, _)| *n != name);
    }
}

fn canonical(name: &str) -> Option<&'static str> {
    KNOWN.iter().copied().find(|known| *known == name)
}

/// What we answered with, and what it means for the connection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Accepted {
    /// The exact `Sec-WebSocket-Extensions` value to echo back, byte for byte
    /// what `ws`'s `extension.format` produces for the same negotiation.
    pub response: String,
    pub params: Params,
}

/// Negotiate one offer against the shipped policy.
pub fn accept(offer: &str) -> Result<Option<Accepted>, NegotiationError> {
    Policy::default().accept(offer)
}

impl Policy {
    /// Agree, decline, or say the header is unacceptable.
    ///
    /// `Ok(None)` means the peer did not offer `permessage-deflate` at all, so
    /// the connection proceeds without it. An `Err` is what `ws` turns into an
    /// HTTP 400 with `Invalid or unacceptable Sec-WebSocket-Extensions header`
    /// (`websocket-server.js:316-320`), which for the four stacks that send the
    /// bare offer would read as a login screen that never loads -- so the rule
    /// this function is held to by `tests/node_parity.rs` is: never refuse what
    /// `ws` accepts.
    pub fn accept(&self, offer: &str) -> Result<Option<Accepted>, NegotiationError> {
        let mut offers: Vec<Offer> = Vec::new();
        for line in parse_extensions(offer) {
            let Some(head) = line.first() else { continue };
            // `ws` looks up exactly one extension name
            // (`websocket-server.js:311`). `permessage_deflate` with an
            // underscore is a different extension to it, so treating that as an
            // offer would compress where the server would not.
            if head.name != "permessage-deflate" {
                continue;
            }
            offers.push(read_offer(&line[1..])?);
        }
        if offers.is_empty() {
            return Ok(None);
        }
        // The first acceptable offer wins and the rest of the header is
        // discarded (`acceptAsServer`'s `offers.find`).
        let Some(mut accepted) = offers.into_iter().find(|o| self.acceptable(o)) else {
            return Err(NegotiationError::UnacceptableParameter(
                "permessage-deflate",
            ));
        };

        // The server's own asks, appended in `acceptAsServer`'s order.
        if self.server_no_context_takeover {
            accepted.put("server_no_context_takeover", Value::Flag);
        }
        if self.client_no_context_takeover {
            accepted.put("client_no_context_takeover", Value::Flag);
        }
        if let Some(bits) = self.server_max_window_bits {
            accepted.put("server_max_window_bits", Value::Number(bits));
        }
        match self.client_max_window_bits {
            Some(bits) => accepted.put("client_max_window_bits", Value::Number(bits)),
            // A bare `client_max_window_bits` in the offer is dropped rather
            // than echoed (`acceptAsServer` deletes it). Echoing the flag back
            // is harmless in the RFC's reading and pointless on the wire; not
            // echoing it is what the fixture says the browser receives.
            None => {
                if accepted.number("client_max_window_bits").is_none() {
                    accepted.remove("client_max_window_bits");
                }
            }
        }

        let params = Params {
            level: self.level,
            mem_level: self.mem_level,
            client_max_window_bits: accepted.number("client_max_window_bits"),
            server_max_window_bits: accepted.number("server_max_window_bits"),
            client_no_context_takeover: accepted.has("client_no_context_takeover"),
            server_no_context_takeover: accepted.has("server_no_context_takeover"),
            max_decompressed_bytes: self.max_decompressed_bytes,
        };
        // A peer that pins OUR window below what the backend can open cannot be
        // served compressed. `ws` would echo the number and deflate at it; the
        // honest equivalent here is to answer without the extension, so the
        // connection proceeds uncompressed instead of writing a stream the peer
        // cannot decode. Note which side of the risk this is on: `ws` ACCEPTS this
        // offer, so declining the extension is not a new refusal and no client
        // that works today stops working -- it just gets no compression. The
        // gateway is expected to count these; a silent bandwidth regression on one
        // client is exactly the thing `docs/RUST.md` keeps warning about.
        if params.outbound_window_bits() < MIN_BACKEND_WINDOW_BITS {
            return Ok(None);
        }
        let mut response = String::from("permessage-deflate");
        for (name, value) in &accepted.params {
            response.push_str("; ");
            response.push_str(name);
            if let Value::Number(bits) = value {
                response.push('=');
                response.push_str(&bits.to_string());
            }
        }
        Ok(Some(Accepted { response, params }))
    }

    /// `acceptAsServer`'s filter, with the two unset window options meaning
    /// "no opinion" and so never rejecting.
    fn acceptable(&self, offer: &Offer) -> bool {
        if !self.server_no_context_takeover && offer.has("server_no_context_takeover") {
            return false;
        }
        if offer.has("server_max_window_bits") {
            if let (Some(ceiling), Some(offered)) = (
                self.server_max_window_bits,
                offer.number("server_max_window_bits"),
            ) {
                if ceiling > offered {
                    return false;
                }
            }
        }
        if self.client_max_window_bits.is_some() && !offer.has("client_max_window_bits") {
            return false;
        }
        true
    }
}

/// Validate one offer's parameters. Everything here is a `TypeError` or `Error`
/// out of `normalizeParams`, which the server turns into a 400.
fn read_offer(params: &[Parameter]) -> Result<Offer, NegotiationError> {
    let mut out = Offer::default();
    for p in params {
        let Some(name) = canonical(&p.name) else {
            return Err(NegotiationError::UnknownParameter(p.name.clone()));
        };
        if out.has(name) {
            return Err(NegotiationError::DuplicateParameter(name));
        }
        let value = match name {
            "client_no_context_takeover" | "server_no_context_takeover" => match &p.value {
                None => Value::Flag,
                Some(v) => {
                    return Err(NegotiationError::MalformedValue {
                        name,
                        value: v.clone(),
                    });
                }
            },
            // `server_max_window_bits` always carries a number: `ws` does `+value`
            // on it, so a bare flag becomes 1 and fails the range check.
            "server_max_window_bits" => match &p.value {
                Some(v) => Value::Number(check_window_bits(name, v)?),
                None => {
                    return Err(NegotiationError::MalformedValue {
                        name,
                        value: String::new(),
                    });
                }
            },
            _ => match &p.value {
                // Chromium's bare flag: supported, no preference, 15 both ways.
                None => Value::Flag,
                Some(v) => Value::Number(check_window_bits(name, v)?),
            },
        };
        out.put(name, value);
    }
    Ok(out)
}

fn check_window_bits(name: &'static str, value: &str) -> Result<u8, NegotiationError> {
    let parsed = value
        .trim()
        .parse::<u8>()
        .map_err(|_| NegotiationError::MalformedValue {
            name,
            value: value.to_string(),
        })?;
    if !(8..=15).contains(&parsed) {
        return Err(NegotiationError::WindowBitsOutOfRange(parsed));
    }
    Ok(parsed)
}

/// The narrowest window this backend can open a stream at.
///
/// RFC 7692 §7.1.2.1 allows 8, `ws` allows 8, and a peer may genuinely name 8.
/// The inbound stream still goes through `flate2`, whose `new_with_window_bits`
/// asserts `9..=15` and PANICS below it (`flate2-1.1.11/src/mem.rs:422`), so a
/// gateway that passed a negotiated value straight through would take down a
/// socket -- or the process, if the panic escaped a worker -- on a legal header.
/// Both constructors are written against this constant rather than trusting the
/// backend to be polite.
///
/// The outbound side could go lower now that it calls `zlib-rs` itself: raw
/// window 8 is accepted there (`zlib-rs-0.6.8/src/deflate.rs:303`) and mapped to
/// 9 internally, which is what zlib does for the same input. That is a behaviour
/// change on a negotiated path rather than a memory fix, so it is not taken here:
/// it needs a fixture where the server encodes at 8 and `ws` decodes it, and
/// today the narrow case declines compression, which cannot corrupt anything.
pub const MIN_BACKEND_WINDOW_BITS: u8 = 9;

/// Output buffer per call: the shipped `chunkSize` reasoning
/// (`ws-compression.ts`) says one buffer per compressed frame, and a
/// roster arrives deflated to about 20 KB.
const SPARE: usize = 1 << 14;

/// Build the outbound stream's config, clamping everything the backend checks.
///
/// `zlib-rs` does not return an error for an out-of-range config: its constructor
/// is `assert_eq!(ret, ReturnCode::Ok)` (`zlib-rs-0.6.8/src/deflate.rs:137`), so a
/// level of 200 or a `mem_level` of 0 aborts the process. `Params` fields are
/// public and a gateway may fill them from a header, so the clamp lives here.
/// `flate2` used to cap the level for us inside `Compression::new`; that is not a
/// smaller worry, it is a worry with a new owner.
fn deflate_config(params: &Params, window_bits: u8) -> DeflateConfig {
    DeflateConfig {
        level: i32::from(params.level.min(9)),
        method: Method::Deflated,
        // Negative is how zlib spells "raw", which is what permessage-deflate is.
        window_bits: -i32::from(window_bits.clamp(MIN_BACKEND_WINDOW_BITS, DEFAULT_WINDOW_BITS)),
        mem_level: i32::from(params.mem_level.clamp(1, 9)),
        strategy: Strategy::Default,
    }
}

/// The outbound direction: one deflate stream for the life of the connection.
pub struct Deflater {
    compress: Deflate,
    no_context_takeover: bool,
    spare: Vec<u8>,
    /// Bytes produced so far, so a peer cannot make us compress forever.
    produced_total: u64,
    max_output_bytes: u64,
}

impl Deflater {
    /// Open the outbound stream, or refuse to.
    ///
    /// Refusing is the only honest option when the peer named a window narrower
    /// than [`MIN_BACKEND_WINDOW_BITS`]. Widening would produce a stream that
    /// back-references further than the peer said it could hold, which decodes to
    /// garbage AT THE PEER -- silent corruption on the other side of the internet
    /// instead of an error here. Declining the extension for that one connection
    /// is the safe failure, and [`Policy::accept`] does exactly that so the
    /// gateway never reaches this error mid-frame.
    pub fn new(params: &Params) -> Result<Self, DeflateError> {
        let window_bits = params.outbound_window_bits();
        if window_bits < MIN_BACKEND_WINDOW_BITS {
            return Err(DeflateError::WindowTooNarrow(window_bits));
        }
        Ok(Self {
            compress: Deflate::new_with_config(deflate_config(params, window_bits)),
            no_context_takeover: params.server_no_context_takeover,
            spare: vec![0u8; SPARE],
            produced_total: 0,
            max_output_bytes: u64::MAX,
        })
    }

    /// Cap the reply, for a gateway that refuses to buffer an endless stream.
    pub fn with_output_cap(mut self, bytes: u64) -> Self {
        self.max_output_bytes = bytes;
        self
    }

    /// Compress one message or fragment. `fin` marks the last of the message,
    /// which is where the sync marker is trimmed and the dictionary dropped.
    pub fn deflate(&mut self, data: &[u8], fin: bool) -> Result<Vec<u8>, DeflateError> {
        let mut out: Vec<u8> = Vec::with_capacity(data.len() / 2 + 64);
        let mut off = 0usize;
        loop {
            let in_before = self.compress.total_in();
            let out_before = self.compress.total_out();
            self.compress
                .compress(&data[off..], &mut self.spare, DeflateFlush::SyncFlush)
                .map_err(|_| DeflateError::Backend)?;
            let consumed = (self.compress.total_in() - in_before) as usize;
            let produced = (self.compress.total_out() - out_before) as usize;
            out.extend_from_slice(&self.spare[..produced]);
            self.produced_total += produced as u64;
            if self.produced_total > self.max_output_bytes {
                return Err(DeflateError::OutputCapExceeded);
            }
            off += consumed;
            if off >= data.len() {
                // A full `spare` means there may be more coming out even though
                // the input is drained, so pump once more with nothing to feed.
                if produced == self.spare.len() {
                    continue;
                }
                break;
            }
            if consumed == 0 && produced == 0 {
                return Err(DeflateError::Backend);
            }
        }
        // `ws` trims the trailing sync marker from the final fragment and the
        // receiver puts it back. The check below is a bound on our own stream,
        // not trust in the peer's.
        if fin {
            if out.len() < TRAILER.len() || out[out.len() - TRAILER.len()..] != TRAILER {
                return Err(DeflateError::MissingSyncMarker);
            }
            out.truncate(out.len() - TRAILER.len());
            if self.no_context_takeover {
                self.compress.reset();
            }
        }
        Ok(out)
    }
}

/// Anything that stopped a compress or inflate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeflateError {
    Backend,
    /// The peer's compressed data expanded past the agreed ceiling: a
    /// decompression bomb, or a peer that will not stop.
    InputTooLarge,
    /// Our own output passed the cap, which means the peer is streaming data at
    /// a rate the connection cannot carry.
    OutputCapExceeded,
    /// The final fragment did not end where a `Z_SYNC_FLUSH` leaves it.
    MissingSyncMarker,
    /// The stream is not raw deflate, or made no progress.
    Corrupt,
    /// The peer negotiated a window below [`MIN_BACKEND_WINDOW_BITS`], which this
    /// backend cannot open. Widening is not an option on the outbound side: see
    /// [`Deflater::new`].
    WindowTooNarrow(u8),
}

impl fmt::Display for DeflateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let why = match self {
            Self::Backend => "the deflate backend refused",
            Self::InputTooLarge => "the message expanded past the agreed ceiling",
            Self::OutputCapExceeded => "the reply grew past the output cap",
            Self::MissingSyncMarker => "the final fragment has no sync marker to trim",
            Self::Corrupt => "the stream is not valid raw deflate",
            Self::WindowTooNarrow(v) => {
                return write!(
                    f,
                    "peer negotiated window bits {v}, below the {MIN_BACKEND_WINDOW_BITS} this backend needs"
                );
            }
        };
        f.write_str(why)
    }
}

impl std::error::Error for DeflateError {}

/// The inbound direction: one inflate stream for the life of the connection.
pub struct Inflater {
    decompress: Decompress,
    window_bits: u8,
    no_context_takeover: bool,
    spare: Vec<u8>,
    produced_total: u64,
    max_output_bytes: u64,
}

impl Inflater {
    pub fn new(params: &Params) -> Self {
        // Widening the DECOMPRESSOR's window is safe and widening the
        // compressor's is not, which is the whole asymmetry in this file. A raw
        // deflate stream says how far back its references may reach; a decoder
        // that keeps MORE history than that still finds every reference it needs
        // and decodes the same bytes. So an 8-bit stream inflates correctly in a
        // 9-bit window -- and `tests/node_parity.rs` proves it on real ws output
        // from `inbound-client-window-8`, rather than on this paragraph.
        let window_bits = params.inbound_window_bits().max(MIN_BACKEND_WINDOW_BITS);
        Self {
            decompress: Decompress::new_with_window_bits(false, window_bits),
            window_bits,
            no_context_takeover: params.client_no_context_takeover,
            spare: vec![0u8; SPARE],
            produced_total: 0,
            max_output_bytes: params.max_decompressed_bytes as u64,
        }
    }

    /// The window this stream actually opened at, which can be wider than the
    /// negotiated one. Observable because the difference is the interesting part:
    /// a gateway's memory claim is about the window it holds, not the one it asked
    /// for.
    pub fn window_bits(&self) -> u8 {
        self.window_bits
    }

    /// Inflate one message or fragment, appending the sync marker on `fin` the
    /// way `ws` does so the pending block becomes readable.
    pub fn inflate(&mut self, data: &[u8], fin: bool) -> Result<Vec<u8>, DeflateError> {
        let mut out: Vec<u8> = Vec::with_capacity(data.len() * 2 + 64);
        // The trailer is the last fragment's marker, not extra input: without
        // `fin` the block stays pending until the next fragment, and an empty
        // result here is correct rather than suspicious.
        let chunks: [&[u8]; 2] = [data, if fin { &TRAILER } else { &[] }];
        for chunk in chunks {
            if chunk.is_empty() {
                continue;
            }
            let mut off = 0usize;
            loop {
                let in_before = self.decompress.total_in();
                let out_before = self.decompress.total_out();
                self.decompress
                    .decompress(&chunk[off..], &mut self.spare, FlushDecompress::Sync)
                    .map_err(|_| DeflateError::Corrupt)?;
                let consumed = (self.decompress.total_in() - in_before) as usize;
                let produced = (self.decompress.total_out() - out_before) as usize;
                out.extend_from_slice(&self.spare[..produced]);
                self.produced_total += produced as u64;
                if self.produced_total > self.max_output_bytes {
                    return Err(DeflateError::InputTooLarge);
                }
                off += consumed;
                if off >= chunk.len() {
                    break;
                }
                if consumed == 0 && produced == 0 {
                    return Err(DeflateError::Corrupt);
                }
            }
        }
        if fin && self.no_context_takeover {
            // Resetting the dictionary is what `no_context_takeover` means, and
            // the window has to stay the one the connection negotiated.
            self.decompress = Decompress::new_with_window_bits(false, self.window_bits);
        }
        Ok(out)
    }
}

/// Encode a compressed fragment the way the fixtures store it.
pub fn encode_base64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Decode a fixture fragment.
pub fn decode_base64(text: &str) -> Result<Vec<u8>, DeflateError> {
    base64::engine::general_purpose::STANDARD
        .decode(text)
        .map_err(|_| DeflateError::Corrupt)
}
