# Builds mockup | app pairs for visual review: test/e2e/out/compare-<name>.png
import os, sys
from PIL import Image
here = os.path.dirname(os.path.abspath(__file__))
for name in sorted(os.listdir(os.path.join(here, 'mockups'))):
    app = os.path.join(here, 'out', name)
    if not os.path.exists(app):
        continue
    a = Image.open(os.path.join(here, 'mockups', name)).convert('RGB')
    b = Image.open(app).convert('RGB')
    h = max(a.height, b.height)
    out = Image.new('RGB', (a.width + b.width + 20, h), (60, 60, 60))
    out.paste(a, (0, 0)); out.paste(b, (a.width + 20, 0))
    out.save(os.path.join(here, 'out', 'compare-' + name))
    print('compare-' + name)
