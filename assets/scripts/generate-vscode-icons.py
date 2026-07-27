"""
Generate VS Code blue ribbon icons for light/dark themes.
Glyph from @vscode/codicons (MIT), unicode U+EC29.
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
FONT_PATH = ROOT.parent / 'node_modules' / '@vscode' / 'codicons' / 'dist' / 'codicon.ttf'
GLYPH = chr(0xEC29)
SIZE = 512
FONT_SIZE = 420
VSCODE_BLUE = '#007ACC'


def render_icon(fill: str) -> Image.Image:
    font = ImageFont.truetype(str(FONT_PATH), FONT_SIZE)
    img = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    bbox = draw.textbbox((0, 0), GLYPH, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    x = (SIZE - tw) / 2 - bbox[0]
    y = (SIZE - th) / 2 - bbox[1]
    draw.text((x, y), GLYPH, font=font, fill=fill)
    return img


def main() -> None:
    blue = render_icon(VSCODE_BLUE)
    blue.save(ROOT / 'icon-dark.png')
    blue.save(ROOT / 'icon-light.png')
    blue.save(ROOT / 'icon.png')
    print('Generated icon-dark.png, icon-light.png, icon.png (VS Code blue)')


if __name__ == '__main__':
    main()
