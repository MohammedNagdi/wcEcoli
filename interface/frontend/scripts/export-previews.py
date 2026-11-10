"""Export real UI captures and their layout dimensions; requires existing Pillow."""
import json
import sys
from pathlib import Path
from PIL import Image

frontend = Path(__file__).resolve().parents[1]
source = Path(sys.argv[1]) if len(sys.argv) > 1 else Path('/private/tmp/wcecoli-previews')
output = frontend / 'public' / 'previews'
manifest = json.loads((source / 'dimensions.json').read_text())
metadata = {}
for name in ['workspace', 'experiment', 'results']:
    dimensions = manifest[name]
    if dimensions != manifest[name + '-dark']:
        raise ValueError(f'{name}: light and dark layout dimensions differ')
    metadata[name] = dimensions
    for suffix in ['', '-dark']:
        image = Image.open(source / f'{name}{suffix}.png').convert('RGB')
        for width, variant, quality in [(720, '-720', 88), (1440, '', 92), (2400, '-2400', 92)]:
            height = round(image.height * width / image.width)
            image.resize((width, height), Image.Resampling.LANCZOS).save(
                output / f'{name}{suffix}{variant}.webp', 'WEBP', quality=quality, method=6)
(frontend / 'src' / 'components' / 'home' / 'previewDimensions.json').write_text(
    json.dumps(metadata, indent=2) + '\n')
print('Exported 18 WebP previews and their intrinsic dimensions')
