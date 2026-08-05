#!/usr/bin/env python3
"""
Generate the PWA / favicon / Electron icon set from one definition.

Run by hand when the mark changes, not in CI — Pillow is not a dependency of
this repo, and the outputs are committed:

    python3 scripts/generate-icons.py

The mark is a speech bubble with three dots: a typing indicator, for a product
whose own tagline is "built for the group that won't shut up". Drawn rather
than typeset because the wordmark needs Unbounded, which is a webfont and is
not available to a rasteriser — and a three-letter wordmark is illegible at
32px anyway.

Everything is drawn on a 4x supersampled canvas and resampled down, which is
what keeps the curves clean at 32px without hinting anything by hand.
"""

from pathlib import Path

from PIL import Image, ImageDraw

# Brand tokens, converted from the oklch values in client/src/index.css.
#   --color-surface-0: oklch(0.16 0.012 250)
#   --color-accent:    oklch(0.88 0.19 125)
INK = (9, 14, 18, 255)
SIGNAL = (187, 236, 76, 255)

SS = 4  # supersampling factor
OUT = Path(__file__).resolve().parent.parent / "client" / "public" / "icons"


def draw_mark(draw: ImageDraw.ImageDraw, size: int, scale: float) -> None:
    """The bubble + three dots, centred, occupying `scale` of the canvas."""
    w = size * scale
    h = w * 0.78
    x0 = (size - w) / 2
    y0 = (size - h) / 2 - size * 0.02

    radius = h * 0.30
    draw.rounded_rectangle([x0, y0, x0 + w, y0 + h], radius=radius, fill=SIGNAL)

    # Tail: a triangle off the bottom-left, overlapping the body so the join
    # is invisible rather than a seam.
    tail_x = x0 + w * 0.24
    tail_w = w * 0.20
    tail_h = h * 0.30
    draw.polygon(
        [
            (tail_x, y0 + h - 2),
            (tail_x + tail_w, y0 + h - 2),
            (tail_x + tail_w * 0.15, y0 + h + tail_h),
        ],
        fill=SIGNAL,
    )

    # Three dots, knocked out of the bubble in the background colour.
    dot_r = h * 0.105
    gap = w * 0.235
    cy = y0 + h * 0.47
    cx = x0 + w / 2
    for offset in (-gap, 0.0, gap):
        draw.ellipse(
            [cx + offset - dot_r, cy - dot_r, cx + offset + dot_r, cy + dot_r],
            fill=INK,
        )


def render(size: int, *, mark_scale: float, corner: float) -> Image.Image:
    """
    `corner` is the background's corner radius as a fraction of the size;
    0 gives a full-bleed square, which is what a maskable icon and an
    apple-touch-icon both want (each platform applies its own mask, and a
    pre-rounded source shows as a rounded shape floating inside that mask).
    """
    canvas = size * SS
    image = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    if corner > 0:
        draw.rounded_rectangle(
            [0, 0, canvas - 1, canvas - 1], radius=canvas * corner, fill=INK
        )
    else:
        draw.rectangle([0, 0, canvas, canvas], fill=INK)

    draw_mark(draw, canvas, mark_scale)
    return image.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)

    targets = [
        # PWA, purpose "any". Rounded, because nothing masks these.
        ("icon-192.png", 192, 0.62, 0.22),
        ("icon-512.png", 512, 0.62, 0.22),
        # PWA, purpose "maskable". Full bleed, and the mark is pulled in to
        # survive the 80% safe zone an aggressive mask can crop to.
        ("icon-maskable-512.png", 512, 0.46, 0.0),
        # iOS applies its own squircle, so this is square and opaque.
        ("apple-touch-icon.png", 180, 0.62, 0.0),
        # Favicons. The mark is pushed larger because at 32px the padding is
        # what disappears first.
        ("favicon-32.png", 32, 0.72, 0.16),
        ("favicon-16.png", 16, 0.78, 0.12),
    ]

    for name, size, mark_scale, corner in targets:
        image = render(size, mark_scale=mark_scale, corner=corner)
        if name in {"apple-touch-icon.png", "icon-maskable-512.png"}:
            # No alpha: iOS composites a transparent icon onto black, and a
            # maskable icon with transparent corners defeats the mask.
            image = image.convert("RGB")
        image.save(OUT / name)
        print(f"wrote {name} ({size}x{size})")


if __name__ == "__main__":
    main()
