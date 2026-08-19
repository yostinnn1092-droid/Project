#!/usr/bin/env python3
"""Generate the launcher icon for every mipmap density.

The icon is drawn once at 4x and downsampled, which is what gives the spikes
clean edges — drawing straight at 48px produces visible stair-stepping on the
diagonals. Colours are the game's own: --void behind, the Ice Crown's blue for
the crown, --force magenta for the rim light.
"""
import os
from PIL import Image, ImageDraw

VOID = (10, 9, 18)
ICE = (191, 233, 255)
ICE_DIM = (108, 160, 200)
FORCE = (233, 79, 191)

SIZES = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
SS = 4  # supersample factor
HERE = os.path.dirname(os.path.abspath(__file__))


def draw_icon(px):
    img = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    u = px / 100.0  # work in percentage units

    d.ellipse([0, 0, px - 1, px - 1], fill=VOID + (255,))
    d.ellipse([1 * u, 1 * u, px - 1 * u, px - 1 * u], outline=FORCE + (90,),
              width=max(1, int(1.5 * u)))

    # Five blades, tallest in the middle, splaying outward at the edges — the
    # same silhouette as the in-game crown read at thumbnail size.
    # Sized to sit inside the circle with margin. Drawn edge to edge the tallest
    # blade is clipped by the round mask most launchers apply.
    blades = [(-25, 24, 5.5), (-13, 33, 6.0), (0, 41, 7.0), (13, 33, 6.0), (25, 24, 5.5)]
    base_y = 68 * u
    for cx_pct, height, halfw in blades:
        cx = (50 + cx_pct) * u
        tip_x = cx + cx_pct * 0.22 * u   # lean away from centre
        tip_y = base_y - height * u
        d.polygon([(cx - halfw * u, base_y), (cx + halfw * u, base_y), (tip_x, tip_y)],
                  fill=ICE + (255,))
        # Shaded right face, so each blade reads as carved rather than flat.
        d.polygon([(cx, base_y), (cx + halfw * u, base_y), (tip_x, tip_y)],
                  fill=ICE_DIM + (255,))

    # The circlet the blades stand on.
    d.rounded_rectangle([24 * u, base_y - 2 * u, 76 * u, base_y + 11 * u],
                        radius=2.5 * u, fill=ICE + (255,))
    d.rectangle([24 * u, base_y + 6 * u, 76 * u, base_y + 11 * u], fill=ICE_DIM + (255,))
    return img


def main():
    master = draw_icon(SIZES["xxxhdpi"] * SS)
    for bucket, px in SIZES.items():
        out_dir = os.path.join(HERE, "res", "mipmap-" + bucket)
        os.makedirs(out_dir, exist_ok=True)
        master.resize((px, px), Image.LANCZOS).save(
            os.path.join(out_dir, "ic_launcher.png"))
        print("mipmap-%s/ic_launcher.png (%dpx)" % (bucket, px))


if __name__ == "__main__":
    main()
