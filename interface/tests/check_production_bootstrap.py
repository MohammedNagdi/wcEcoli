"""Test actual Hub SDK against a local private-Dataset transport, real HF-06 bytes.

No Hugging Face account, token or remote repository is used. This tests transport
and cache behavior, not real Hub authorization (which belongs to HF-08).
"""

import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from threading import Thread
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[2]
RELEASE = ROOT / "interface/.pilot/explorer-release"
PYTHON = ROOT / "interface/.explorer/venv/bin/python"
REVISION = "a" * 40
TOKEN = "dummy-local-transport-token"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    manifest = json.loads((RELEASE / "manifest.json").read_text())
    files = {f["path"]: f for f in manifest["files"]}
    files["manifest.json"] = dict(sha256=hashlib.sha256((RELEASE / "manifest.json").read_bytes()).hexdigest(),
                                 bytes=(RELEASE / "manifest.json").stat().st_size)
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass  # No authorization headers or signed URLs in logs.

        def serve(self, head):
            if self.headers.get("Authorization") != "Bearer " + TOKEN:
                requests.append(dict(method=self.command, status=401))
                self.send_error(401)
                return
            prefix = f"/datasets/local/private/resolve/{REVISION}/release/"
            path = unquote(self.path)
            name = path[len(prefix):] if path.startswith(prefix) else ""
            if name not in files:
                self.send_error(404)
                return
            item = files[name]
            requests.append(dict(method=self.command, path=name, status=200))
            self.send_response(200)
            self.send_header("Content-Length", str(item["bytes"]))
            self.send_header("ETag", '"' + item["sha256"] + '"')
            self.send_header("X-Repo-Commit", REVISION)
            self.end_headers()
            if not head:
                with (RELEASE / name).open("rb") as stream:
                    shutil.copyfileobj(stream, self.wfile, length=1024 * 1024)

        def do_HEAD(self):
            self.serve(True)

        def do_GET(self):
            self.serve(False)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with tempfile.TemporaryDirectory(prefix="hf07-real-transport-") as temporary:
            temp = Path(temporary)
            env = dict(os.environ, PYTHONPATH=str(ROOT / "interface/backend"),
                       EXPLORER_DATA_MODE="hub", EXPLORER_CACHE=str(temp / "cache"),
                       EXPLORER_RELEASE=str(temp / "active"), HF_TOKEN=TOKEN,
                       EXPLORER_DATASET_REPO="local/private", EXPLORER_DATASET_REVISION=REVISION,
                       EXPLORER_MANIFEST_SHA256=files["manifest.json"]["sha256"],
                       HF_ENDPOINT=f"http://127.0.0.1:{server.server_port}",
                       HF_HUB_DISABLE_XET="1", HF_HUB_DISABLE_TELEMETRY="1",
                       HF_HUB_DISABLE_PROGRESS_BARS="1", HF_HUB_DISABLE_IMPLICIT_TOKEN="1")
            program = "from hf_export.release_bootstrap import prepare; p=prepare(); print(p.resolve())"

            def run(**overrides):
                return subprocess.run([str(PYTHON), "-c", program], env=dict(env, **overrides),
                                      text=True, capture_output=True, timeout=300)

            denied = run(HF_TOKEN="dummy-wrong-token")
            assert denied.returncode != 0 and "permission" in denied.stderr
            assert TOKEN not in denied.stdout + denied.stderr
            assert not (temp / "active").exists()
            first = run()
            assert first.returncode == 0, first.stderr
            assert TOKEN not in first.stdout + first.stderr
            gets = [r["path"] for r in requests if r["method"] == "GET" and r["status"] == 200]
            assert gets == ["manifest.json"] + [f["path"] for f in manifest["files"]]
            downloaded = Path(first.stdout.strip())
            assert {p.relative_to(downloaded).as_posix() for p in downloaded.rglob("*") if p.is_file()} == set(files)
            for name, item in files.items():
                with (downloaded / name).open("rb") as stream:
                    assert hashlib.file_digest(stream, "sha256").hexdigest() == item["sha256"]
            count = len(requests)
            offline = run(HF_TOKEN="", HF_HUB_OFFLINE="1")
            assert offline.returncode == 0 and len(requests) == count, offline.stderr
            missing = run(EXPLORER_DATASET_REVISION="b" * 40, HF_TOKEN="", HF_HUB_OFFLINE="1")
            assert missing.returncode != 0 and "cache miss" in missing.stderr
            assert len(requests) == count
            report = dict(passed=True, transport="local HTTP private-Dataset fixture using actual pinned SDK",
                          real_hub_authentication="deferred to HF-08; no real credentials used",
                          release_files=len(files), bytes=sum(f["bytes"] for f in files.values()),
                          manifest_first=True, exact_hashes=True, offline_cache=True,
                          wrong_token_rejected=True, missing_revision_no_fallback=True,
                          requests=requests)
            args.out.parent.mkdir(parents=True, exist_ok=True)
            args.out.write_text(json.dumps(report, indent=2) + "\n")
            print(json.dumps({k: v for k, v in report.items() if k != "requests"}))
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
