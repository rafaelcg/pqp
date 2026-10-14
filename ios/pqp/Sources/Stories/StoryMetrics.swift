import Foundation
import QuartzCore

/// Timestamps for measuring how fast Stories feel, written to a file in the
/// app's Documents folder. Debug builds only, and only with
/// `PQP_STORY_METRICS=1` in the environment: a release build has no code here.
///
/// Marks: `post.tap` (the Post button), `composer.closed` (the composer is
/// gone), `post.live` (the server accepted the publish), `next.tap` (a tap to
/// the next story), `frame.base` / `frame.poster` (a picture is on screen),
/// `frame.video` (the player has its first frame).
enum StoryMetrics {
    #if DEBUG
    private static let enabled = ProcessInfo.processInfo.environment["PQP_STORY_METRICS"] == "1"

    static func mark(_ name: String) {
        guard enabled else { return }
        let line = String(format: "%.4f\t%@\n", CACurrentMediaTime(), name)
        let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("story-metrics.log")
        if let handle = try? FileHandle(forWritingTo: url) {
            handle.seekToEndOfFile()
            handle.write(Data(line.utf8))
            try? handle.close()
        } else {
            try? Data(line.utf8).write(to: url)
        }
    }
    #else
    @inline(__always) static func mark(_ name: String) {}
    #endif
}
