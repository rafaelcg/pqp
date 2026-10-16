import SwiftUI
import UIKit

/// The dot beside each name in the composer's background menu: the card's own
/// colours (the gradient family drawn at its own slant), ringed and ticked when
/// it is the one in use. A `Menu` tints SF Symbols with one colour (every dot
/// was the same lime, QA S3) but keeps an image that asks for its own pixels,
/// so these are drawn once per key and state and marked `.alwaysOriginal`.
enum StorySwatch {
    static let points: CGFloat = 26
    @MainActor private static var cache: [String: UIImage] = [:]

    @MainActor
    static func image(key: String, selected: Bool) -> UIImage {
        let id = "\(key)-\(selected)"
        if let cached = cache[id] { return cached }
        let colors = StoryRules.backgroundColors(key).map { UIColor($0).cgColor }
        let size = CGSize(width: points, height: points)
        let image = UIGraphicsImageRenderer(size: size).image { context in
            let cg = context.cgContext
            let rect = CGRect(origin: .zero, size: size).insetBy(dx: 2, dy: 2)
            cg.saveGState()
            cg.addEllipse(in: rect)
            cg.clip()
            if let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors as CFArray, locations: [0, 1]) {
                cg.drawLinearGradient(
                    gradient,
                    start: CGPoint(x: rect.minX + rect.width * 0.2, y: rect.minY),
                    end: CGPoint(x: rect.maxX - rect.width * 0.2, y: rect.maxY),
                    options: [.drawsBeforeStartLocation, .drawsAfterEndLocation]
                )
            }
            cg.restoreGState()
            cg.setLineWidth(selected ? 2.5 : 1)
            cg.setStrokeColor(UIColor.white.withAlphaComponent(selected ? 1 : 0.35).cgColor)
            cg.strokeEllipse(in: selected ? rect.insetBy(dx: 0.5, dy: 0.5) : rect)
            if selected {
                cg.setLineWidth(2.4)
                cg.setLineCap(.round)
                cg.setLineJoin(.round)
                cg.setStrokeColor(UIColor.white.cgColor)
                cg.move(to: CGPoint(x: size.width * 0.34, y: size.height * 0.52))
                cg.addLine(to: CGPoint(x: size.width * 0.46, y: size.height * 0.64))
                cg.addLine(to: CGPoint(x: size.width * 0.68, y: size.height * 0.38))
                cg.strokePath()
            }
        }
        let original = image.withRenderingMode(.alwaysOriginal)
        cache[id] = original
        return original
    }
}
