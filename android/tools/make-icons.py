#!/usr/bin/env python3
"""从 packaging/assets/icon-512.png 生成 Android 全套启动图标。

产出：
  app/src/main/res/mipmap-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/ic_launcher.png        传统方形图标（API < 26）
  app/src/main/res/mipmap-*/ic_launcher_round.png                                 传统圆形图标
  app/src/main/res/mipmap-*/ic_launcher_foreground.png                            自适应图标前景（108dp 画布）
  app/src/main/res/mipmap-anydpi-v26/ic_launcher{,_round}.xml                     自适应图标（API >= 26）

自适应图标的安全区是居中 66dp/108dp，本脚本把整块 squircle 缩到画布的 88% 居中 ——
四周留一点底色，任何形状的蒙版都不会切到主体。
"""
import os
from PIL import Image, ImageDraw

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SRC = os.path.join(REPO, "packaging", "assets", "icon-512.png")
RES = os.path.join(REPO, "android", "app", "src", "main", "res")

LEGACY = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
ADAPTIVE = {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}


def scaled(src: Image.Image, size: int) -> Image.Image:
    return src.resize((size, size), Image.LANCZOS)


def main() -> None:
    src = Image.open(SRC).convert("RGBA")
    bg_hex = "#%02X%02X%02X" % src.convert("RGB").getpixel((4, 4))[:3]

    for dpi, size in LEGACY.items():
        out = os.path.join(RES, f"mipmap-{dpi}")
        os.makedirs(out, exist_ok=True)
        scaled(src, size).save(os.path.join(out, "ic_launcher.png"))

        # 圆形：先画圆蒙版，再贴图（略微内缩，避免圆边裁到 squircle 的角）
        rnd = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        inner = int(size * 0.94)
        art = scaled(src, inner)
        mask = Image.new("L", (size, size), 0)
        ImageDraw.Draw(mask).ellipse((0, 0, size - 1, size - 1), fill=255)
        rnd.paste(art, ((size - inner) // 2, (size - inner) // 2), art)
        rnd.putalpha(mask)
        rnd.save(os.path.join(out, "ic_launcher_round.png"))

    for dpi, canvas in ADAPTIVE.items():
        out = os.path.join(RES, f"mipmap-{dpi}")
        os.makedirs(out, exist_ok=True)
        fg = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
        inner = int(canvas * 0.88)
        art = scaled(src, inner)
        fg.paste(art, ((canvas - inner) // 2, (canvas - inner) // 2), art)
        fg.save(os.path.join(out, "ic_launcher_foreground.png"))

    anydpi = os.path.join(RES, "mipmap-anydpi-v26")
    os.makedirs(anydpi, exist_ok=True)
    adaptive = (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
        '    <background android:drawable="@color/icon_bg" />\n'
        '    <foreground android:drawable="@mipmap/ic_launcher_foreground" />\n'
        '</adaptive-icon>\n'
    )
    for name in ("ic_launcher.xml", "ic_launcher_round.xml"):
        with open(os.path.join(anydpi, name), "w", encoding="utf-8") as f:
            f.write(adaptive)

    print("图标背景色（取自源图左上角）:", bg_hex)


if __name__ == "__main__":
    main()
