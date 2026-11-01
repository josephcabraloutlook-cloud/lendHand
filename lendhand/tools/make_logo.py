# Derives transparent white / green versions of the supplied wordmark.
# The lettering is not redrawn: the alpha mask is read straight from the supplied artwork.
import sys
from PIL import Image
src, out = sys.argv[1], sys.argv[2]
im = Image.open(src).convert("RGB")
r = im.getchannel("R")
bg = 3
mask = r.point(lambda v: max(0, min(255, round((v - bg) * 255 / (255 - bg)))))
bbox = mask.point(lambda v: 255 if v > 24 else 0).getbbox()
pad = 6
bbox = (bbox[0]-pad, bbox[1]-pad, bbox[2]+pad, bbox[3]+pad)
mask = mask.crop(bbox)
print("size", mask.size)
for name, rgb in (("lendhand-white", (255,255,255)), ("lendhand-green", (0,201,40))):
    layer = Image.new("RGBA", mask.size, rgb + (0,))
    layer.putalpha(mask)
    layer.save(f"{out}/{name}.png", optimize=True)
# square app icon: white wordmark on brand green with generous padding
w, h = mask.size
S = 512
icon = Image.new("RGB", (S, S), (0,201,40))
logo = Image.new("RGBA", mask.size, (255,255,255,0)); logo.putalpha(mask)
tw = int(S*0.78); th = round(h*tw/w)
logo = logo.resize((tw, th), Image.LANCZOS)
icon.paste(logo, ((S-tw)//2, (S-th)//2), logo)
icon.save(f"{out}/icon-512.png", optimize=True)
icon.resize((180,180), Image.LANCZOS).save(f"{out}/apple-touch-icon.png", optimize=True)
# social share image 1200x630
og = Image.new("RGB", (1200, 630), (0,201,40))
tw = 760; th = round(h*tw/w)
lg = Image.new("RGBA", mask.size, (255,255,255,0)); lg.putalpha(mask)
lg = lg.resize((tw, th), Image.LANCZOS)
og.paste(lg, ((1200-tw)//2, (630-th)//2 - 20), lg)
og.save(f"{out}/og-image.png", optimize=True)
