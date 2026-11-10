"""Single production web process. Import only the allowlisted artifact adapter."""

import os
from pathlib import Path

from fastapi import HTTPException
from fastapi.responses import FileResponse

from . import preview
from .release_bootstrap import expected_digest

preview.ROOT = Path(os.environ.get("EXPLORER_RELEASE", "/data/current"))
preview.REQUIRE_FULL_RELEASE = True
preview.EXPECTED_MANIFEST_SHA256 = expected_digest()
app = preview.app
STATIC = Path(os.environ.get("EXPLORER_STATIC", "/app/static")).resolve()
# Minimal Python images omit parts of the OS MIME database (notably WebP).
# Pin the formats produced by our frontend rather than relying on host guesses.
ASSET_MIME = {".webp": "image/webp", ".woff2": "font/woff2", ".woff": "font/woff",
              ".ttf": "font/ttf", ".svg": "image/svg+xml", ".js": "text/javascript",
              ".css": "text/css"}


@app.get("/{path:path}", include_in_schema=False)
def frontend(path: str):
    # API typos and administrative/debug routes must never become successful HTML.
    first = path.split("/", 1)[0]
    if first in {"api", "docs", "redoc", "openapi.json", "admin", "debug"}:
        raise HTTPException(404, "Not found")
    target = (STATIC / path).resolve()
    if not target.is_relative_to(STATIC):
        raise HTTPException(404, "Not found")
    if target.is_file():
        return FileResponse(target, media_type=ASSET_MIME.get(target.suffix.lower()),
                            headers={"X-Content-Type-Options": "nosniff"})
    # Missing assets get an actual 404, never index.html with the wrong MIME type.
    if first in {"assets", "previews"} or Path(path).suffix:
        raise HTTPException(404, "Asset not found")
    index = STATIC / "index.html"
    if not index.is_file():
        raise HTTPException(503, "Explorer frontend is unavailable")
    return FileResponse(index, headers={"Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff"})
