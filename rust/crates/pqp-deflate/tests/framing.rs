//! The framing and negotiation rules `ws` applies, tested against this crate
//! rather than trusted to a reading of the RFC.

use pqp_deflate::{
    accept, parse_extensions, DeflateError, Deflater, Inflater, Params, Policy,
    DEFAULT_WINDOW_BITS, MIN_BACKEND_WINDOW_BITS,
};

/// The offers `ws-compression.ts:20` measured off the five stacks that actually
/// connect. Four of them name no window at all.
const OFFERS: [(&str, &str); 5] = [
    ("chromium", "permessage-deflate; client_max_window_bits"),
    ("firefox", "permessage-deflate"),
    ("webkit", "permessage-deflate"),
    ("ios-cfnetwork", "permessage-deflate"),
    ("android-okhttp", "permessage-deflate"),
];

#[test]
fn every_stack_that_connects_is_accepted() {
    for (who, offer) in OFFERS {
        let got = accept(offer).unwrap_or_else(|e| panic!("{who} offer {offer:?} refused: {e}"));
        let accepted = got.unwrap_or_else(|| panic!("{who} offer was not recognised"));
        // The response must name nothing the offer did not name: `ws` turns a
        // response that adds `client_max_window_bits=15` into HTTP 400 for the
        // four stacks that never offered it.
        assert!(
            !accepted.response.contains("max_window_bits"),
            "{who}: response {}/{:?} pins a window the peer never offered",
            accepted.response,
            accepted.params
        );
        // The shipped policy asks for no context takeover in either direction,
        // and `ws` writes both flags into the response from ITS options, not the
        // peer's. Dropping them is still a working connection -- with a
        // per-socket window that grows for the life of the socket, which is the
        // memory behaviour `ws-compression.ts` exists to bound. `ws`'s own
        // `extension.format` output is in the fixtures and `node_parity.rs`
        // compares this string byte for byte.
        assert_eq!(
            accepted.response,
            "permessage-deflate; server_no_context_takeover; client_no_context_takeover",
            "{who}"
        );
        assert!(accepted.params.server_no_context_takeover, "{who}");
        assert!(accepted.params.client_no_context_takeover, "{who}");
        assert_eq!(
            accepted.params.inbound_window_bits(),
            DEFAULT_WINDOW_BITS,
            "{who}"
        );
        assert_eq!(
            accepted.params.outbound_window_bits(),
            DEFAULT_WINDOW_BITS,
            "{who}"
        );
    }
}

/// A number the PEER offered is echoed back. Only a number neither side named
/// would be an unsolicited parameter, and that is the case that 400s. The first
/// draft of this file asserted the opposite and was wrong: `ws` keeps the
/// offered value in the accepted parameters (`acceptAsServer` only deletes a
/// bare flag), so the response really does say `client_max_window_bits=8`.
#[test]
fn a_number_offered_by_the_peer_is_echoed_and_used() {
    let accepted = accept("permessage-deflate; client_max_window_bits=12")
        .unwrap()
        .expect("offered");
    assert_eq!(accepted.params.client_max_window_bits, Some(12));
    assert_eq!(accepted.params.inbound_window_bits(), 12);
    assert!(
        accepted.response.contains("client_max_window_bits=12"),
        "{}",
        accepted.response
    );
}

/// The peer is allowed to name OUR window, and `ws` honours it verbatim rather
/// than ignoring it: the fixture's 9-bit vector compresses to 2631 bytes where
/// the 15-bit one reaches 1996, so the narrower stream is real and observable.
#[test]
fn a_window_the_peer_named_for_us_is_honoured_not_ignored() {
    let accepted = accept("permessage-deflate; server_max_window_bits=9")
        .unwrap()
        .expect("offered");
    assert_eq!(accepted.params.outbound_window_bits(), 9);
    assert_eq!(accepted.params.inbound_window_bits(), DEFAULT_WINDOW_BITS);
    assert!(
        accepted.response.contains("server_max_window_bits=9"),
        "{}",
        accepted.response
    );
}

/// `acceptAsServer` uses `offers.find`, so the first offer that passes decides
/// the connection and everything after the first comma is discarded. Merging the
/// parameters of several lines instead would name a window the peer's first
/// choice did not ask for.
#[test]
fn the_first_acceptable_offer_decides_and_the_rest_is_discarded() {
    let accepted = accept(
        "permessage-deflate; server_max_window_bits=12, permessage-deflate; client_max_window_bits",
    )
    .unwrap()
    .expect("offered");
    assert_eq!(
        accepted.response,
        "permessage-deflate; server_max_window_bits=12; server_no_context_takeover; client_no_context_takeover"
    );
    assert_eq!(accepted.params.outbound_window_bits(), 12);
    assert_eq!(accepted.params.inbound_window_bits(), DEFAULT_WINDOW_BITS);
}

/// A flag parameter that arrives with a value is a `TypeError` in `ws`, and a
/// bare `server_max_window_bits` is `+true` = 1, which fails the range. Both are
/// a 400 there, so neither may become a silently ignored parameter here.
#[test]
fn a_flag_with_a_value_and_a_valueless_number_are_both_refused() {
    for offer in [
        "permessage-deflate; server_no_context_takeover=1",
        "permessage-deflate; client_no_context_takeover=yes",
        "permessage-deflate; server_max_window_bits",
    ] {
        let err = accept(offer).expect_err("ws throws on all three");
        assert!(
            err.to_string().contains("invalid value"),
            "{offer} produced {err}"
        );
    }
}

/// An offer this policy cannot meet is a REFUSED connection, not a connection
/// that quietly drops compression, because that is what `ws` does with it
/// (`websocket-server.js:316`). Naming a window number is the way to reach this
/// arm, and the reason `Policy::default()` names none.
#[test]
fn an_offer_the_policy_cannot_meet_is_a_refusal_not_a_downgrade() {
    let policy = Policy {
        client_max_window_bits: Some(12),
        ..Policy::default()
    };
    let err = policy
        .accept("permessage-deflate")
        .expect_err("a peer that offered no window cannot be told one");
    assert!(err.to_string().contains("permessage-deflate"), "{err}");
    // The same header is fine with the shipped policy.
    assert!(accept("permessage-deflate").unwrap().is_some());
}

#[test]
fn an_out_of_range_window_is_not_silently_clamped() {
    // RFC 7692 allows 8..=15. Clamping a 7 would silently change what the peer
    // is owed; the first draft returned 15 here because None meant "unset".
    for bad in ["7", "16", "200", "banana"] {
        let offer = format!("permessage-deflate; client_max_window_bits={bad}");
        let err = accept(&offer).expect_err("must not accept an illegal window");
        assert!(
            err.to_string().contains(bad) || err.to_string().contains("window bits"),
            "{bad} produced {err}"
        );
    }
}

#[test]
fn no_extension_offer_is_no_offer() {
    assert_eq!(accept("x-unknown-extension").unwrap(), None);
    assert_eq!(accept("").unwrap(), None);
    // The underscore spelling is a different extension to `ws`, whose lookup is
    // by the exact name `permessage-deflate`. Compressing where the server would
    // not is a behaviour change on the handshake.
    assert_eq!(accept("permessage_deflate").unwrap(), None);
}

/// RFC 7692 §9.1 says ignore what you do not understand. The server this crate
/// replaces does not: `ws` throws `Unknown parameter` (`permessage-deflate.js:288`)
/// and the handshake fails. Parity with the shipped peer wins over the kindlier
/// reading, because a gateway that *accepts* what Node rejects moves the
/// disagreement onto a client that is working today.
#[test]
fn an_unknown_parameter_is_refused_like_the_shipped_peer_refuses_it() {
    let err = accept("permessage-deflate; future_thing=9; client_max_window_bits")
        .expect_err("ws would throw on this offer");
    assert!(err.to_string().contains("future_thing"), "{err}");
}

#[test]
fn a_parameter_offered_twice_is_refused() {
    let err = accept("permessage-deflate; client_max_window_bits=9; client_max_window_bits=12")
        .expect_err("ws throws: a parameter must have only a single value");
    assert!(err.to_string().contains("more than once"), "{err}");
}

#[test]
fn a_server_window_the_peer_cannot_decode_is_refused_before_streams_open() {
    // 9 and 15 are inside the RFC's range but a bogus window on the *inbound*
    // direction is still worth rejecting rather than opening a stream at it.
    let err = accept("permessage-deflate; server_max_window_bits=3").expect_err("out of range");
    assert!(err.to_string().contains("8..=15"), "{err}");
}

/// A peer may name window bits 8: RFC 7692 §7.1.2.1 allows it and `ws` accepts
/// it. `flate2` panics below 9. The two directions have to be answered
/// differently, and the difference is the point of this test:
///
///   outbound  encoding wider than the peer declared = references it cannot
///             resolve = garbage at the peer. So: decline the extension, and say
///             so (`docs/RUST.md` counts these) rather than write a bad stream.
///   inbound   decoding with MORE history than the peer used is loss-free, so the
///             connection keeps its compression at the floor window.
#[test]
fn a_window_below_the_backend_floor_declines_instead_of_panicking() {
    // Negotiation first, so the gateway never reaches a stream it cannot open.
    assert_eq!(
        accept("permessage-deflate; server_max_window_bits=8").unwrap(),
        None
    );
    // Still not a refusal of the CONNECTION: the same header without the pin is
    // accepted, so this client connects -- uncompressed.
    assert!(accept("permessage-deflate").unwrap().is_some());

    // And the constructor says so instead of aborting the thread.
    let params = Params {
        server_max_window_bits: Some(MIN_BACKEND_WINDOW_BITS - 1),
        ..Params::default()
    };
    assert_eq!(
        Deflater::new(&params).err(),
        Some(DeflateError::WindowTooNarrow(8))
    );

    let params = Params {
        client_max_window_bits: Some(8),
        ..Params::default()
    };
    assert_eq!(
        Inflater::new(&params).window_bits(),
        MIN_BACKEND_WINDOW_BITS
    );
}

#[test]
fn commas_inside_quotes_do_not_split_an_extension_line() {
    let lines = parse_extensions(r#"permessage-deflate; note="a,b"; client_max_window_bits"#);
    assert_eq!(lines.len(), 1, "{lines:?}");
    assert_eq!(lines[0].len(), 3, "{:?}", lines[0]);
}

/// One connection, many messages, dictionary carried over: the whole point of
/// context takeover, and the thing a per-message implementation gets wrong.
#[test]
fn a_sequence_round_trips_over_one_stream_each_way() {
    let params = Params::default();
    let mut out = Deflater::new(&params).expect("window is inside the backend's range");
    let mut back = Inflater::new(&params);
    let messages: Vec<String> = (0..40)
        .map(|i| format!(r#"{{"type":"voice-roster","seq":{i},"participants":[]}}"#))
        .collect();
    let mut second_message_bytes = 0usize;
    for (i, m) in messages.iter().enumerate() {
        let fin = true;
        let compressed = out.deflate(m.as_bytes(), fin).expect("deflate");
        if i == 1 {
            second_message_bytes = compressed.len();
        }
        let decoded = back.inflate(&compressed, fin).expect("inflate");
        assert_eq!(decoded, m.as_bytes(), "message {i} came back different");
        assert_eq!(decoded.len(), m.len(), "message {i} lost a tail");
    }
    // With takeover the second message must be smaller than the first, because
    // the first one is already in the dictionary. If this ever stops holding,
    // takeover is quietly off and the wire is paying for it.
    assert!(
        second_message_bytes < messages[0].len() / 2,
        "no takeover: second message took {second_message_bytes} of {} bytes",
        messages[0].len()
    );
}

#[test]
fn the_sync_marker_is_trimmed_from_the_last_fragment_only() {
    let params = Params::default();
    let mut out = Deflater::new(&params).expect("window is inside the backend's range");
    let fragmented = out
        .deflate(b"hello ", false)
        .expect("deflate first fragment");
    assert!(
        fragmented.ends_with(&[0x00, 0x00, 0xff, 0xff]),
        "a non-final fragment keeps its marker: {fragmented:02x?}"
    );
    let final_fragment = out.deflate(b"world", true).expect("deflate final");
    assert!(
        !final_fragment.ends_with(&[0x00, 0x00, 0xff, 0xff]),
        "the final fragment must not carry the marker: {final_fragment:02x?}"
    );
}

#[test]
fn fragments_of_one_message_reassemble() {
    let params = Params::default();
    let mut out = Deflater::new(&params).expect("window is inside the backend's range");
    let mut back = Inflater::new(&params);
    let mut wire = Vec::new();
    wire.extend(out.deflate(b"the quick ", false).unwrap());
    wire.extend(out.deflate(b"brown fox ", false).unwrap());
    wire.extend(out.deflate(b"jumps", true).unwrap());
    // `ws` feeds each fragment with its own fin flag; a single buffer with the
    // last one flagged is the same stream, so both have to decode.
    let got = back.inflate(&wire, true).unwrap();
    assert_eq!(got, b"the quick brown fox jumps");
}

#[test]
fn no_context_takeover_drops_the_dictionary_between_messages() {
    let params = Params {
        server_no_context_takeover: true,
        client_no_context_takeover: true,
        ..Params::default()
    };
    let mut out = Deflater::new(&params).expect("window is inside the backend's range");
    let mut back = Inflater::new(&params);
    let heavy = "x".repeat(20_000);
    let first = out.deflate(heavy.as_bytes(), true).unwrap();
    let second = out.deflate(heavy.as_bytes(), true).unwrap();
    assert_eq!(back.inflate(&first, true).unwrap().len(), heavy.len());
    assert_eq!(back.inflate(&second, true).unwrap().len(), heavy.len());
    // Reset means the second message pays for itself again, so it must *not*
    // collapse to the near-nothing that takeover would give.
    assert!(
        second.len() > first.len() / 4,
        "dictionary survived a reset that was asked for: {} then {} bytes",
        first.len(),
        second.len()
    );
}

#[test]
fn window_bits_is_actually_honoured_and_not_just_stored() {
    // The reason flate2's `zlib-rs` backend is required: on the default backend
    // there is no way to open a stream at a chosen window at all. A narrow
    // window must compress the same repetitive input worse than a wide one, and
    // both must still round-trip, or the parameter is decoration.
    let repetitive = "pqp.gg voice roster ".repeat(4_000);
    let mut sizes = Vec::new();
    for bits in [9u8, 15] {
        let params = Params {
            server_max_window_bits: Some(bits),
            client_max_window_bits: Some(bits),
            ..Params::default()
        };
        let mut out = Deflater::new(&params).expect("window is inside the backend's range");
        let mut back = Inflater::new(&params);
        let compressed = out.deflate(repetitive.as_bytes(), true).unwrap();
        assert_eq!(
            back.inflate(&compressed, true).unwrap(),
            repetitive.as_bytes()
        );
        sizes.push(compressed.len());
    }
    assert!(
        sizes[0] > sizes[1],
        "a 512 B window compressed {}/{} vs 32 KiB window: the parameter is ignored",
        sizes[0],
        sizes[1]
    );
}

#[test]
fn an_inflatable_bomb_is_refused_not_allocated() {
    // 8 MiB of zeros deflates to a few kilobytes; the ceiling has to stop the
    // inflate, not merely describe it.
    let params = Params {
        max_decompressed_bytes: 1 << 20,
        ..Params::default()
    };
    let mut out =
        Deflater::new(&Params::default()).expect("default window is inside the backend's range");
    let bomb = vec![0u8; 8 << 20];
    let compressed = out.deflate(&bomb, true).unwrap();
    let mut back = Inflater::new(&params);
    let err = back
        .inflate(&compressed, true)
        .expect_err("a bomb must not inflate to completion");
    assert_eq!(err, pqp_deflate::DeflateError::InputTooLarge, "{err}");
}

#[test]
fn garbage_is_refused_instead_of_returning_noise() {
    let params = Params::default();
    let mut back = Inflater::new(&params);
    let junk: Vec<u8> = (0..=255u8).cycle().take(400).collect();
    let err = back
        .inflate(&junk, true)
        .expect_err("random bytes are not a deflate stream");
    assert!(matches!(
        err,
        pqp_deflate::DeflateError::Corrupt | pqp_deflate::DeflateError::InputTooLarge
    ));
}

#[test]
fn the_memory_level_the_policy_asks_for_is_the_one_we_open_with() {
    // `ws-compression.ts:50` ships memLevel 6 to hold a socket's deflate state
    // down, and this used to assert that nothing honoured it while the stream
    // went through `flate2`. The outbound side now calls `zlib-rs` directly, so
    // the assertion points the other way. It stays a test on purpose: if the
    // backend changes and the parameter stops reaching `deflateInit2`, the
    // gateway quietly pays 48 KiB per socket more than it asked for, and nothing
    // except this line notices. `tests/memory.rs` measures the bytes.
    assert!(Params::default().mem_level_is_honoured());
    assert_eq!(Params::default().mem_level, 6);
}
