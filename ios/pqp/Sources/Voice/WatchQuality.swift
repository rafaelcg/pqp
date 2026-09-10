import AVFoundation
import Foundation

/**
 THE RUNGS A BROADCAST IS ACTUALLY SERVING, AND WHICH ONE THIS PHONE IS ON.

 READ THE MASTER, NEVER A LIST WE WROTE DOWN. The ladder is a server decision
 (`server/src/voice/hls-ladder.ts`) and it is configurable: today a party
 publishes 720p30 and 1080p30, tomorrow it publishes three rungs or one. A
 picker offering resolutions the master playlist does not advertise is a picker
 that hands somebody a rung nobody is encoding, so everything here is built
 from `AVAsset.variants`, which is the master playlist as the player parsed it.

 THIS IS NOT `VideoQuality`. That enum is what this phone SENDS, and its rungs
 are a contract with the far end of a call. This is what this phone RECEIVES
 from a broadcast, it is per viewer, it changes nothing for anybody else, and
 the rungs are whatever the egress happened to start. Sharing a type between
 the two would tie a viewer's choice to a publisher's contract.

 AUTO IS THE DEFAULT AND IT ALREADY WORKED. Worth stating plainly, because
 "there is no quality control on iOS" reads as "iOS is pinned to something".
 It is not: nothing sets `preferredMaximumResolution` or `preferredPeakBitRate`
 on the item, so `AVPlayer` has been picking a variant and adapting on its own
 since the player shipped. What was missing was the control and, more
 importantly, the honesty: a viewer on mobile data could not see which rung
 they were paying for, and could not refuse the expensive one.
 */
struct WatchRung: Equatable, Identifiable, Sendable {
    /// Picture lines, which is what "720p" has always meant and what the label
    /// says.
    let lines: Int
    /// The variant's full presentation size, handed to
    /// `preferredMaximumResolution` verbatim. Kept rather than rebuilt from
    /// `lines` and an assumed aspect ratio: a screen share is not 16:9.
    let size: CGSize
    /// `AVAssetVariant.peakBitRate`, in bits per second, when the master
    /// declared one.
    let peakBitRate: Double?

    var id: Int { lines }

    /// A measurement, so it is not translated. Matches the web's rung labels.
    var label: String { "\(lines)p" }
}

/// What a viewer picked. `nil` lines is Auto.
struct WatchQualityChoice: Equatable, Sendable {
    /// The pinned rung's lines, or nil for Auto.
    var lines: Int?

    static let auto = WatchQualityChoice(lines: nil)
}

/**
 The ladder as this player sees it, plus the two numbers that pin it.

 `preferredMaximumResolution` and `preferredPeakBitRate` are both CEILINGS
 rather than selections, which is the right shape for this: pinning 720p on a
 two rung ladder means "720p or below", so a viewer whose link cannot carry
 even that still gets a picture rather than a stall. Both are live properties
 of `AVPlayerItem`, so changing the choice re-tunes the player already running
 and costs no re-buffer, which is why the picker does not go anywhere near
 `attach`.
 */
struct WatchLadder: Equatable, Sendable {
    /// Tallest first, which is the order a picker reads in.
    let rungs: [WatchRung]

    static let empty = WatchLadder(rungs: [])

    /// Whether a picker is worth drawing at all. One rung is not a choice, and
    /// a gear that opens a menu of one item is worse than no gear.
    var isWorthOffering: Bool { rungs.count > 1 }

    /// Built from what the master playlist declared, de-duplicated by lines.
    ///
    /// A ladder can advertise two variants at the same height (an audio only
    /// rendition, or two bitrates of one size). The taller bitrate wins,
    /// because the ceiling it sets is the one that admits both.
    static func from(variants: [(size: CGSize, peakBitRate: Double?)]) -> WatchLadder {
        var byLines: [Int: WatchRung] = [:]
        for variant in variants {
            let lines = Int(variant.size.height.rounded())
            guard lines > 0 else { continue }
            let rung = WatchRung(
                lines: lines, size: variant.size, peakBitRate: variant.peakBitRate
            )
            if let existing = byLines[lines],
               (existing.peakBitRate ?? 0) >= (rung.peakBitRate ?? 0) {
                continue
            }
            byLines[lines] = rung
        }
        return WatchLadder(rungs: byLines.values.sorted { $0.lines > $1.lines })
    }

    /// The ceilings for a choice. Auto is `(.zero, 0)`, which is
    /// `AVPlayerItem`'s own word for "no ceiling" on both properties.
    ///
    /// A choice naming a rung this ladder does not have falls back to Auto
    /// rather than to the nearest rung. The viewer's pin is remembered across
    /// broadcasts and the next broadcast may publish a different ladder; a
    /// silent substitution would leave somebody who chose 480p watching 1080p
    /// on mobile data and being told 480p.
    func limits(for choice: WatchQualityChoice) -> (resolution: CGSize, peakBitRate: Double) {
        guard let lines = choice.lines,
              let rung = rungs.first(where: { $0.lines == lines })
        else {
            return (.zero, 0)
        }
        return (rung.size, rung.peakBitRate ?? 0)
    }

    /// Whether the remembered pin still names a rung this broadcast serves.
    func contains(_ choice: WatchQualityChoice) -> Bool {
        guard let lines = choice.lines else { return true }
        return rungs.contains { $0.lines == lines }
    }

    /**
     THE CEILING THE PANE ITSELF IMPLIES, WHICH IS THE ONE NOBODY WAS SETTING.

     A watch party publishes 1080p30 at about 4.6 Mbps. Inline, above the
     transcript, the picture occupies a strip a phone wide: around 1170 device
     pixels across and 660 tall on a 3x screen, and rather less than that in
     practice. Decoding 1080p to draw it there throws away more than half of
     every frame, and it costs the phone a 4.6 Mbps download, a 1080p decode
     and a downscale per frame to do it. Auto had no ceiling at all
     (`preferredMaximumResolution` was never set), so on a good link
     `AVPlayer` climbed to the tallest rung and stayed there, whatever size the
     picture was being drawn at.

     `preferredMaximumResolution` is Apple's own answer to exactly this and its
     documented use is exactly this case, a player displayed in a small view.
     Fullscreen re-asks with the full screen's pixels, so the same rule that
     holds 720p in the strip allows 1080p when the picture is worth it.

     THE CLAMP IS THE PART THAT MATTERS. A ceiling under every rung on the
     ladder is a ceiling that describes no variant, and the point of a ceiling
     is to choose among rungs rather than to rule them all out. So it never
     goes below the shortest rung published, and an empty ladder (a master not
     parsed yet, or a single media playlist from a pre-ladder session) gets no
     ceiling at all rather than a guess.
     */
    func resolutionCap(surfacePixels: CGSize, choice: WatchQualityChoice) -> CGSize {
        let pinned = choice.lines.flatMap { lines in rungs.first { $0.lines == lines } }
        guard let shortest = rungs.last else {
            // No ladder to choose within. A pin is still honoured if it named
            // a size; otherwise no ceiling, which is what shipped.
            return pinned?.size ?? .zero
        }
        let candidates = [pinned?.size, validSurface(surfacePixels)].compactMap { $0 }
        guard let smallest = candidates.min(by: { $0.height < $1.height }) else {
            return .zero
        }
        return smallest.height < shortest.size.height ? shortest.size : smallest
    }

    /// A surface with no area is a view that has not been laid out yet, and
    /// capping to zero would be capping to nothing at all.
    private func validSurface(_ size: CGSize) -> CGSize? {
        size.width > 0 && size.height > 0 ? size : nil
    }
}

/// What the control says out loud.
///
/// AUTO HAS TO NAME THE RUNG IT SETTLED ON. "Automático" alone tells a viewer
/// on mobile data nothing, and the whole complaint behind this control was not
/// being able to see what the phone was doing. `presentationSize` is the size
/// actually being decoded, so this is measured rather than requested, which is
/// the same rule `VideoQuality`'s doc comment argues for on the sending side.
enum WatchQualityLabel {
    static func text(choice: WatchQualityChoice, effectiveLines: Int?) -> String {
        if let lines = choice.lines {
            return "\(lines)p"
        }
        guard let effectiveLines, effectiveLines > 0 else {
            return String(localized: "Auto")
        }
        return String(localized: "Auto (\(effectiveLines)p)")
    }
}

/**
 The master playlist's variants, read once per attach.

 `AVURLAsset.load(.variants)` parses the master this player is already going to
 fetch, so this costs one extra request at most and nothing at all when the
 response is still in the URL cache. It is deliberately tolerant: a failure
 here means no picker, never no picture.
 */
/**
 WHEN A LIVE ITEM MAY HAVE ITS CEILINGS REWRITTEN.

 `preferredMaximumResolution` is a live property, and writing it is a
 rendition switch. On a ten second playlist that switch is "plays for a
 few seconds, then stops": the master finishes parsing, the pane reports
 its size, Auto writes a 720p cap onto an item that has already started
 at 1080, and `AVPlayer` sits in `.waitingToPlayAtSpecifiedRate` while
 the window slides past.

 So variants and layout may only write BEFORE the first `play()`. A pin
 or the theater is a person asking, and that write is allowed (with a
 seek back to live on the other side).
 */
enum WatchQualityRetune {
    enum Trigger: Equatable {
        case variants
        case surface
        case pin
        case fullscreen
    }

    static func shouldWrite(alreadyPlaying: Bool, trigger: Trigger) -> Bool {
        switch trigger {
        case .pin, .fullscreen:
            return true
        case .variants, .surface:
            return !alreadyPlaying
        }
    }
}

enum WatchVariants {
    static func load(from asset: AVURLAsset) async -> WatchLadder {
        guard let variants = try? await asset.load(.variants) else { return .empty }
        let described = variants.compactMap { variant -> (size: CGSize, peakBitRate: Double?)? in
            guard let size = variant.videoAttributes?.presentationSize else { return nil }
            return (size: size, peakBitRate: variant.peakBitRate)
        }
        return .from(variants: described)
    }
}
