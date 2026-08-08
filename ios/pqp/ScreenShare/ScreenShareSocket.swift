import Foundation

/// The extension's end of the bridge: connect, write frames, notice when the app
/// is gone.
///
/// Deliberately blocking. `processSampleBuffer` is already called on ReplayKit's
/// own serial queue, and a blocking write there is the backpressure: if the app
/// cannot keep up, the extension waits rather than growing a queue inside a
/// process with a 50 MB ceiling.
final class ScreenShareSocketClient {
    private var descriptor: Int32 = -1

    var isConnected: Bool { descriptor >= 0 }

    /// Opens the connection. False means the app is not listening — which is the
    /// normal case when a broadcast is started while the app is not in a call.
    func connect(to url: URL) -> Bool {
        close()
        guard var address = sockaddrUn(for: url.path) else { return false }
        let socketDescriptor = socket(AF_UNIX, SOCK_STREAM, 0)
        guard socketDescriptor >= 0 else { return false }
        // Without this a write to a socket the app has closed raises SIGPIPE and
        // takes the extension down with it, mid-broadcast.
        var on: Int32 = 1
        setsockopt(socketDescriptor, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))

        let connected = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
                Darwin.connect(socketDescriptor, sockaddrPointer, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard connected == 0 else {
            Darwin.close(socketDescriptor)
            return false
        }
        descriptor = socketDescriptor
        return true
    }

    /// Writes every byte, retrying short writes. False means the link is dead and
    /// the caller should stop trying.
    @discardableResult
    func write(_ data: Data) -> Bool {
        guard descriptor >= 0 else { return false }
        return data.withUnsafeBytes { raw -> Bool in
            var offset = 0
            while offset < raw.count {
                let written = Darwin.write(
                    descriptor,
                    raw.baseAddress!.advanced(by: offset),
                    raw.count - offset
                )
                if written > 0 {
                    offset += written
                    continue
                }
                if written < 0 && errno == EINTR { continue }
                return false
            }
            return true
        }
    }

    func close() {
        guard descriptor >= 0 else { return }
        Darwin.close(descriptor)
        descriptor = -1
    }
}

/// The app's end: listen, accept one broadcast at a time, hand whole frames up.
///
/// Polled rather than blocking, so `stop()` is a flag rather than closing a
/// descriptor another thread is parked inside.
///
/// `@unchecked Sendable` because every mutable field is touched only on `queue`
/// (or, for `isRunning`, through a lock) — the type is a serial actor in all but
/// name, and cannot be an actor because its loop is a blocking `poll`.
final class ScreenShareSocketServer: @unchecked Sendable {
    private let queue = DispatchQueue(label: "gg.pqp.screenshare.bridge")
    private let lock = NSLock()
    private var running = false
    private var listenDescriptor: Int32 = -1
    private var clientDescriptor: Int32 = -1
    private var parser = ScreenShareFrameParser()
    private let onFrame: @Sendable (ScreenShareFrameHeader, Data) -> Void

    /// Longest `sockaddr_un.sun_path` Darwin accepts, including its terminator.
    static let maximumPathLength = 104

    init(onFrame: @escaping @Sendable (ScreenShareFrameHeader, Data) -> Void) {
        self.onFrame = onFrame
    }

    deinit { stop() }

    /// Binds and starts accepting. False means the socket could not be created —
    /// no App Group entitlement, or a container path too long for `sockaddr_un`,
    /// which is the simulator's situation and one reason the extension is
    /// device-only.
    func start(at url: URL) -> Bool {
        stop()
        // A socket file from a previous run is not reusable and `bind` fails on
        // it, so it goes first. Nothing else lives at this name.
        try? FileManager.default.removeItem(at: url)
        guard var address = sockaddrUn(for: url.path) else { return false }
        let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else { return false }

        let bound = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
                bind(descriptor, sockaddrPointer, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bound == 0, listen(descriptor, 1) == 0 else {
            Darwin.close(descriptor)
            return false
        }
        setNonBlocking(descriptor)
        listenDescriptor = descriptor
        lock.withLock { running = true }
        queue.async { [weak self] in self?.loop() }
        return true
    }

    func stop() {
        lock.withLock { running = false }
        // Closed here rather than on the queue: the loop only ever polls with a
        // timeout, so it notices the flag within one tick and touches nothing
        // after that.
        if clientDescriptor >= 0 {
            Darwin.close(clientDescriptor)
            clientDescriptor = -1
        }
        if listenDescriptor >= 0 {
            Darwin.close(listenDescriptor)
            listenDescriptor = -1
        }
    }

    private var isRunning: Bool { lock.withLock { running } }

    private func loop() {
        while isRunning {
            if clientDescriptor < 0 {
                acceptOne()
                continue
            }
            readAvailable()
        }
    }

    private func acceptOne() {
        let descriptor = listenDescriptor
        guard descriptor >= 0, poll(descriptor, timeoutMs: 200) else { return }
        let accepted = accept(descriptor, nil, nil)
        guard accepted >= 0 else { return }
        setNonBlocking(accepted)
        var on: Int32 = 1
        setsockopt(accepted, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
        parser.reset()
        clientDescriptor = accepted
    }

    private func readAvailable() {
        let descriptor = clientDescriptor
        guard descriptor >= 0, poll(descriptor, timeoutMs: 200) else { return }
        var chunk = [UInt8](repeating: 0, count: 64 * 1024)
        let read = chunk.withUnsafeMutableBytes { raw in
            Darwin.read(descriptor, raw.baseAddress, raw.count)
        }
        if read > 0 {
            guard let frames = parser.append(Data(chunk[0..<read])) else {
                // Out of sync. Dropping the connection makes the extension
                // reconnect with a fresh stream, which is the only recovery
                // worth having on a link only this app writes to.
                dropClient()
                return
            }
            for frame in frames { onFrame(frame.header, frame.payload) }
            return
        }
        if read < 0 && (errno == EAGAIN || errno == EINTR) { return }
        // 0 is a clean close by the extension, anything else is a broken link;
        // both mean "wait for the next broadcast".
        dropClient()
    }

    private func dropClient() {
        if clientDescriptor >= 0 {
            Darwin.close(clientDescriptor)
            clientDescriptor = -1
        }
        parser.reset()
    }

    private func poll(_ descriptor: Int32, timeoutMs: Int32) -> Bool {
        var descriptorSet = pollfd(fd: descriptor, events: Int16(POLLIN), revents: 0)
        let result = withUnsafeMutablePointer(to: &descriptorSet) {
            Darwin.poll($0, 1, timeoutMs)
        }
        return result > 0 && descriptorSet.revents & Int16(POLLIN) != 0
    }

    private func setNonBlocking(_ descriptor: Int32) {
        let flags = fcntl(descriptor, F_GETFL, 0)
        _ = fcntl(descriptor, F_SETFL, flags | O_NONBLOCK)
    }
}

/// Fills a `sockaddr_un`, or refuses a path Darwin cannot hold.
///
/// The limit is 104 bytes including the terminator, which is why the socket is
/// named `s.sock`: an App Group container path on a device is already ~90
/// characters, and a longer name would silently truncate into a path nobody
/// binds.
private func sockaddrUn(for path: String) -> sockaddr_un? {
    let bytes = Array(path.utf8)
    guard !bytes.isEmpty,
          bytes.count < ScreenShareSocketServer.maximumPathLength else { return nil }
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    withUnsafeMutableBytes(of: &address.sun_path) { raw in
        raw.copyBytes(from: bytes)
        raw[bytes.count] = 0
    }
    return address
}
