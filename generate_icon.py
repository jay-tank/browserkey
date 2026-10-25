#!/usr/bin/env python3
"""Generate icon.png (128x128) for the BrowserKey VS Code extension.

Rounded-square amber-to-red gradient drawn at 4x and downscaled with LANCZOS. Glyph: a white
browser window outline (title bar with three dots) with a bold white key over its lower right.
"""

from PIL import Image, ImageDraw

SIZE = 128
SCALE = 4
BIG = SIZE * SCALE

TOP_COLOR = (255, 179, 0)    # amber
BOTTOM_COLOR = (214, 40, 40)  # red
WHITE = (255, 255, 255, 255)


def rounded_gradient_bg(size, top_color, bottom_color, radius_ratio=0.22):
    gradient = Image.new("RGB", (size, size))
    gdraw = ImageDraw.Draw(gradient)
    for d in range(2 * size - 1):
        t = d / (2 * size - 2)
        c = tuple(int(top_color[i] + (bottom_color[i] - top_color[i]) * t) for i in range(3))
        gdraw.line([(d, 0), (0, d)], fill=c, width=2)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([(0, 0), (size - 1, size - 1)], radius=int(size * radius_ratio), fill=255)
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    img.paste(gradient, (0, 0))
    img.putalpha(mask)
    return img


def draw_glyph(img):
    s = img.size[0]
    d = ImageDraw.Draw(img)
    w = int(s * 0.045)
    # Browser window.
    x0, y0, x1, y1 = s * 0.14, s * 0.18, s * 0.86, s * 0.76
    d.rounded_rectangle([(x0, y0), (x1, y1)], radius=int(s * 0.06), outline=WHITE, width=w)
    bar = y0 + s * 0.14
    d.line([(x0, bar), (x1, bar)], fill=WHITE, width=w)
    r = s * 0.025
    for i in range(3):
        cx = x0 + s * 0.08 + i * s * 0.07
        cy = (y0 + bar) / 2
        d.ellipse([(cx - r, cy - r), (cx + r, cy + r)], fill=WHITE)
    # Key: ring at upper left of the lower area, shaft to the lower right, two teeth.
    ring_c = (s * 0.42, s * 0.56)
    ring_r = s * 0.12
    # Gradient-coloured disc behind the key so it reads on top of the window outline.
    bg = img.getpixel((int(ring_c[0]), int(ring_c[1])))
    d.ellipse([(ring_c[0] - ring_r - w, ring_c[1] - ring_r - w), (ring_c[0] + ring_r + w, ring_c[1] + ring_r + w)], fill=bg)
    d.ellipse([(ring_c[0] - ring_r, ring_c[1] - ring_r), (ring_c[0] + ring_r, ring_c[1] + ring_r)], outline=WHITE, width=int(s * 0.06))
    sw = int(s * 0.065)
    sx0 = ring_c[0] + ring_r * 0.9
    sy = ring_c[1] + ring_r * 0.55
    ex, ey = s * 0.88, s * 0.84
    # Shaft outline in background colour first (separates it from the window frame), then white.
    d.line([(sx0, sy), (ex, ey)], fill=bg, width=sw + 2 * w)
    d.line([(sx0, sy), (ex, ey)], fill=WHITE, width=sw)
    # Teeth perpendicular to the shaft.
    import math
    ang = math.atan2(ey - sy, ex - sx0)
    px, py = -math.sin(ang), math.cos(ang)
    for t, ln in ((0.62, 0.10), (0.85, 0.075)):
        bx = sx0 + (ex - sx0) * t
        by = sy + (ey - sy) * t
        d.line([(bx, by), (bx + px * s * ln, by + py * s * ln)], fill=WHITE, width=int(s * 0.055))


def main():
    big = rounded_gradient_bg(BIG, TOP_COLOR, BOTTOM_COLOR)
    draw_glyph(big)
    final = big.resize((SIZE, SIZE), Image.LANCZOS)
    final.save("icon.png")
    print("Wrote icon.png (%dx%d)" % (SIZE, SIZE))


if __name__ == "__main__":
    main()
