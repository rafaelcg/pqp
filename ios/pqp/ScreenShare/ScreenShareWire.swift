import Foundation

/// The contract between the ReplayKit broadcast extension and the app.
///
/// Compiled into **both** targets, which is why nothing here imports WebRTC,
/// Clerk or SwiftUI: a broadcast upload extension runs under a hard ~50 MB
/// memory limit and gets killed rather than warned, so it links the smallest
/// possible amount of this app.
///
/// ## Why a Unix domain socket
///
/// iOS screen recording happens in a *separate process* — the extension gets the
/// `CMSampleBuffer`s and the app owns the WebRTC peer connections, so frames
/// have to cross a process boundary sixty times a second. Of the options an App
/// Group container allows:
///
///  - **A Unix domain socket** (this): ordered, framed, with real backpressure,
///    and a write that fails *tells* the extension the app is gone. One syscall
///    per frame, no polling, no file churn.
///  - Shared memory + a Darwin notification: needs a hand-rolled ring buffer and
///    its own tearing/ordering discipline, and the notification channel carries
///    no payload, so it is a socket with extra steps and more ways to be wrong.
///  - Files in the container: writes hit the disk, and the reader has to poll or
///    watch, which adds latency to every frame for no benefit.
///
/// ## Why raw NV12 rather than JPEG
///
/// WebRTC on iOS consumes a `CVPixelBuffer` directly (`RTCCVPixelBuffer`), and
/// ReplayKit hands the extension one. Sending NV12 bytes means no encode in the
/// extension and no decode in the app — an encoder in a 50 MB process, feeding a
/// decoder, to cross a link that is local memory, would be pure loss. The link
/// is bounded instead by shrinking the picture: ≤720p on the long side at
/// `defaultFrameRate`, which is ~16 MB/s of memcpy, and the H.264 encode that
/// actually costs something happens once, in WebRTC, where it always did.
enum ScreenShareWire {
    /// Shared by the app and the extension. Must match the App Groups
    /// entitlement of both targets exactly.
    static let appGroupIdentifier = "group.gg.pqp.app"

    /// The extension's bundle id, for `RPSystemBroadcastPickerView`.
    static let broadcastExtensionIdentifier = "gg.pqp.app.broadcast"

    /// Socket name inside the group container. Short on purpose: a
    /// `sockaddr_un` path is 104 bytes including the container prefix.
    static let socketName = "s.sock"

    /// Longest side of a published frame. A shared screen is read, not admired;
    /// 720p is legible for code and slides and is the point past which a mesh
    /// call on a phone battery stops being worth it.
    static let maxLongSide = 1280

    /// Frames per second. Screen content is mostly static, and every frame is
    /// an encode per peer in a mesh.
    static let defaultFrameRate: Double = 12

    /// How long a silent bridge is tolerated before the app unpublishes.
    ///
    /// Stopping a broadcast from the status-bar indicator or Control Centre does
    /// not notify the app at all — the extension simply stops being called, and
    /// on some paths is killed without `broadcastFinished()` ever running. Going
    /// quiet is therefore the only signal that exists. Two seconds is long
    /// enough that a stalled screen (nothing moving, nothing to send) does not
    /// read as a stop, and short enough that nobody watches a frozen frame.
    static let staleTimeout: TimeInterval = 2

    /// `"PQPS"`, so a stale socket from an older build is rejected rather than
    /// misread as geometry.
    static let magic: UInt32 = 0x5051_5053
    static let version: UInt16 = 1
    static let headerSize = 20

    /// The socket path, or nil when the App Group is not available — which on a
    /// real build means the entitlement is missing rather than anything the user
    /// did, so callers surface it rather than retrying.
    static func socketURL(
        fileManager: FileManager = .default
    ) -> URL? {
        fileManager
            .containerURL(forSecurityApplicationGroupIdentifier: appGroupIdentifier)?
            .appendingPathComponent(socketName)
    }
}

/// One frame's geometry, as it travels.
///
/// The payload is always tightly packed NV12 (`420YpCbCr8BiPlanar`): `width *
/// height` bytes of luma followed by `width * height / 2` bytes of interleaved
/// chroma. Tight packing is what lets the length be derived rather than trusted
/// — a corrupt header cannot make the reader allocate a gigabyte.
struct ScreenShareFrameHeader: Equatable, Sendable {
    /// Both even. NV12 chroma is subsampled 2×2, so an odd dimension has no
    /// representation.
    let width: Int
    let height: Int
    /// Degrees clockwise the receiver must rotate to make the picture upright:
    /// 0, 90, 180 or 270. ReplayKit rotates the *buffer* rather than the frame
    /// when the device turns.
    let rotation: Int

    init(width: Int, height: Int, rotation: Int = 0) {
        self.width = width
        self.height = height
        self.rotation = rotation
    }

    /// Bytes of NV12 payload this geometry implies.
    var payloadLength: Int { width * height + width * (height / 2) }

    var lumaLength: Int { width * height }
    var chromaLength: Int { width * (height / 2) }

    /// A header that could not have come from this protocol.
    var isPlausible: Bool {
        width > 0 && height > 0
            && width % 2 == 0 && height % 2 == 0
            // Nothing this app publishes is bigger; the guard is against a
            // corrupt length turning into an allocation.
            && width <= 4096 && height <= 4096
            && [0, 90, 180, 270].contains(rotation)
    }

    func encoded() -> Data {
        var data = Data(capacity: ScreenShareWire.headerSize)
        data.appendLittleEndian(ScreenShareWire.magic)
        data.appendLittleEndian(ScreenShareWire.version)
        data.appendLittleEndian(UInt16(rotation))
        data.appendLittleEndian(UInt32(width))
        data.appendLittleEndian(UInt32(height))
        data.appendLittleEndian(UInt32(payloadLength))
        return data
    }

    /// Parses a header. Returns nil for anything that is not one — a truncated
    /// read, a foreign writer, or a length that disagrees with the geometry.
    static func decode(_ data: Data) -> ScreenShareFrameHeader? {
        guard data.count >= ScreenShareWire.headerSize else { return nil }
        let bytes = [UInt8](data.prefix(ScreenShareWire.headerSize))
        guard bytes.littleEndian32(at: 0) == ScreenShareWire.magic,
              bytes.littleEndian16(at: 4) == ScreenShareWire.version else { return nil }
        let header = ScreenShareFrameHeader(
            width: Int(bytes.littleEndian32(at: 8)),
            height: Int(bytes.littleEndian32(at: 12)),
            rotation: Int(bytes.littleEndian16(at: 6))
        )
        guard header.isPlausible,
              Int(bytes.littleEndian32(at: 16)) == header.payloadLength else { return nil }
        return header
    }
}

/// One frame off the wire.
struct ScreenShareFrame: Equatable, Sendable {
    let header: ScreenShareFrameHeader
    let payload: Data
}

/// Reassembles frames from a byte stream.
///
/// A stream socket has no message boundaries: one `read` can hold three frames,
/// half a frame, or a header split across two syscalls. This is the part of the
/// bridge most likely to be subtly wrong and the part that can be tested without
/// a device at all, so it lives here rather than inside the socket.
struct ScreenShareFrameParser: Sendable {
    private var buffer = Data()

    /// Adds bytes and returns every whole frame now available.
    ///
    /// Returns nil when the stream is out of sync — a header where a header
    /// cannot be. There is no resynchronising on a link only this app writes to,
    /// so the caller drops the connection and lets the extension reconnect.
    mutating func append(_ chunk: Data) -> [ScreenShareFrame]? {
        buffer.append(chunk)
        var frames: [ScreenShareFrame] = []
        while buffer.count >= ScreenShareWire.headerSize {
            guard let header = ScreenShareFrameHeader.decode(buffer) else {
                buffer.removeAll(keepingCapacity: false)
                return nil
            }
            let total = ScreenShareWire.headerSize + header.payloadLength
            guard buffer.count >= total else { break }
            // `subdata` rather than a slice: a `Data` slice keeps the parent
            // buffer alive, so every frame would pin the whole read.
            frames.append(ScreenShareFrame(
                header: header,
                payload: buffer.subdata(in: ScreenShareWire.headerSize..<total)
            ))
            buffer.removeSubrange(0..<total)
        }
        return frames
    }

    mutating func reset() {
        buffer.removeAll(keepingCapacity: false)
    }
}

/// The size a captured screen is published at.
///
/// Even in both axes (NV12 has no odd dimension) and never larger than the
/// source: upscaling a screen costs bandwidth and adds nothing, and iPhone
/// screens are already below the ceiling in one axis.
func screenShareTargetSize(
    width: Int,
    height: Int,
    maxLongSide: Int = ScreenShareWire.maxLongSide
) -> (width: Int, height: Int) {
    guard width > 0, height > 0, maxLongSide >= 2 else { return (0, 0) }
    let longSide = max(width, height)
    let scale = longSide > maxLongSide ? Double(maxLongSide) / Double(longSide) : 1
    return (
        width: evenDimension(Double(width) * scale, limit: width),
        height: evenDimension(Double(height) * scale, limit: height)
    )
}

/// Rounds to an even number of pixels, at least 2 and never above the source.
private func evenDimension(_ value: Double, limit: Int) -> Int {
    let rounded = Int(value.rounded())
    let clamped = min(max(rounded, 2), max(limit, 2))
    return clamped % 2 == 0 ? clamped : clamped - 1
}

/// Decides which captured frames are published.
///
/// ReplayKit delivers at the display's rate. Forwarding all of it would mean
/// sixty NV12 memcpys a second across the socket and sixty encodes per peer, for
/// content that is usually a still page — so frames are dropped here, in the
/// cheapest possible place, before any scaling work is done.
struct ScreenShareFrameClock: Sendable {
    /// Minimum gap between published frames.
    let minimumInterval: TimeInterval
    private var lastPublished: TimeInterval?

    init(frameRate: Double = ScreenShareWire.defaultFrameRate) {
        minimumInterval = frameRate > 0 ? 1 / frameRate : 0
    }

    /// Whether to publish a frame presented at `time`, and records it if so.
    ///
    /// The first frame always goes: a share that waits a twelfth of a second to
    /// show anything looks broken at exactly the moment the user is looking for
    /// confirmation that it worked.
    mutating func shouldPublish(at time: TimeInterval) -> Bool {
        guard let lastPublished else {
            self.lastPublished = time
            return true
        }
        // A clock that went backwards (a new capture session, a rebased
        // timebase) publishes rather than stalling until it catches up.
        guard time >= lastPublished else {
            self.lastPublished = time
            return true
        }
        guard time - lastPublished >= minimumInterval else { return false }
        self.lastPublished = time
        return true
    }
}

/// Whether a bridge that was delivering frames has gone quiet long enough to
/// count as stopped. `nil` means it never started, which is not a stop.
func screenShareIsStale(
    lastFrameAt: TimeInterval?,
    now: TimeInterval,
    timeout: TimeInterval = ScreenShareWire.staleTimeout
) -> Bool {
    guard let lastFrameAt else { return false }
    return now - lastFrameAt >= timeout
}

// MARK: - Byte helpers

extension Data {
    fileprivate mutating func appendLittleEndian(_ value: UInt32) {
        append(UInt8(truncatingIfNeeded: value))
        append(UInt8(truncatingIfNeeded: value >> 8))
        append(UInt8(truncatingIfNeeded: value >> 16))
        append(UInt8(truncatingIfNeeded: value >> 24))
    }

    fileprivate mutating func appendLittleEndian(_ value: UInt16) {
        append(UInt8(truncatingIfNeeded: value))
        append(UInt8(truncatingIfNeeded: value >> 8))
    }
}

extension [UInt8] {
    fileprivate func littleEndian32(at index: Int) -> UInt32 {
        UInt32(self[index])
            | UInt32(self[index + 1]) << 8
            | UInt32(self[index + 2]) << 16
            | UInt32(self[index + 3]) << 24
    }

    fileprivate func littleEndian16(at index: Int) -> UInt16 {
        UInt16(self[index]) | UInt16(self[index + 1]) << 8
    }
}
