import CoreGraphics

/// The box a picture in the transcript takes BEFORE its bytes arrive.
///
/// An image row used to be a 140pt placeholder that became a 260pt picture
/// (or a zero-height embed that became a 160pt one) the moment the download
/// finished. Every row that did that moved everything under it, so a channel
/// that had just opened on its latest message slid away from it again a beat
/// later, once per picture on screen.
///
/// The server already sends the pixel size: an upload states it
/// (`createAttachmentSchema`'s `width`/`height`, which say in as many words
/// that they exist "so the message can reserve the right box before the image
/// loads") and an unfurl records `imageWidth`/`imageHeight`. This turns that
/// into the exact frame `.resizable().scaledToFit()` inside a
/// `maxWidth`/`maxHeight` frame would have settled on, so the row is its final
/// height from its first layout and the picture fills in without moving
/// anything.
enum MediaBox {
    /// The aspect-fit size of `width`×`height` inside `maxWidth`×`maxHeight`.
    ///
    /// Scales UP as well as down, because that is what the view it reserves
    /// space for does: a resizable image with a max frame fills the box. Nil
    /// when either dimension is missing or not positive, which leaves the
    /// caller on its old, unreserved layout rather than guessing a shape.
    static func fitted(
        width: Int?, height: Int?, maxWidth: CGFloat, maxHeight: CGFloat
    ) -> CGSize? {
        guard let width, let height, width > 0, height > 0, maxWidth > 0, maxHeight > 0 else {
            return nil
        }
        let w = CGFloat(width)
        let h = CGFloat(height)
        let scale = min(maxWidth / w, maxHeight / h)
        // Whole points: a fractional frame rounds differently on the two
        // sides of the load and reintroduces the half-point jump this removes.
        return CGSize(width: (w * scale).rounded(), height: (h * scale).rounded())
    }
}
