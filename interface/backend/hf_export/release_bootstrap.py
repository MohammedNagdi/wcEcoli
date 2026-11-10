"""Pinned private Dataset bootstrap. Never imports the server or scientific code.

Only inventory/checksums are checked here. The one serving process performs the
full structural/HDF5 validation in lifespan before accepting any connections.
"""

from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import sys
import tempfile
import time

DEFAULT_MANIFEST_SHA256 = "5ec44906b5ef88152261a77676959e624fa7cb4ba65dc3bcd517799373228a18"
SHA256 = re.compile(r"[0-9a-f]{64}")
MAX_BYTES = 10_000_000_000
MANIFEST_LIMIT = 8 * 1024**2


class BootstrapError(ValueError):
    """A safe operational error; no HTTP headers, tokens or signed URLs."""


def digest(path):
    with Path(path).open("rb") as stream:
        value = hashlib.sha256()
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
        return value.hexdigest()


def expected_digest(env=None):
    env = os.environ if env is None else env
    value = env.get("EXPLORER_MANIFEST_SHA256", DEFAULT_MANIFEST_SHA256)
    if not SHA256.fullmatch(value):
        raise BootstrapError("EXPLORER_MANIFEST_SHA256 must be a complete SHA-256")
    return value


def inventory(root, expected):
    """Trust filenames only after authenticating the small, pinned manifest."""
    path = root / "manifest.json"
    if path.is_symlink() or path.stat().st_size > MANIFEST_LIMIT or digest(path) != expected:
        raise BootstrapError("Dataset manifest fingerprint/size mismatch")
    manifest = json.loads(path.read_text())
    if manifest.get("scope", "full") != "full" or manifest.get("synthetic_fixture") is not False or not manifest.get("references"):
        raise BootstrapError("Production requires a real full explorer release with references")
    files = manifest.get("files", [])
    names = set()
    total = path.stat().st_size
    for item in files:
        name, size, sha = item["path"], item["bytes"], item["sha256"]
        pure = PurePosixPath(name)
        if (not name or pure.is_absolute() or ".." in pure.parts or "\\" in name
                or str(pure) != name or name in names or name in {".", "manifest.json"}
                or type(size) is not int or size < 0 or not SHA256.fullmatch(sha)):
            raise BootstrapError("Invalid Dataset payload inventory")
        names.add(name)
        total += size
    if not names or total > MAX_BYTES:
        raise BootstrapError("Dataset inventory exceeds the 10 GB ceiling or is empty")
    return files, total


def verify_payloads(root, expected):
    files, total = inventory(root, expected)
    paths = list(root.rglob("*"))
    if any(p.is_symlink() or (not p.is_file() and not p.is_dir()) for p in paths):
        raise BootstrapError("Dataset payload must contain only ordinary files/directories")
    if {p.relative_to(root).as_posix() for p in paths if p.is_file()} != {f["path"] for f in files} | {"manifest.json"}:
        raise BootstrapError("Dataset has missing or unlisted files")
    for item in files:
        path = root / item["path"]
        if path.stat().st_size != item["bytes"] or digest(path) != item["sha256"]:
            raise BootstrapError("Dataset payload size/checksum mismatch: " + item["path"])
    return total


@contextmanager
def deadline(seconds):
    """A process-wide bound also covers client retries and blocked network I/O."""
    def expired(*_):
        raise BootstrapError("Dataset download deadline exceeded")
    previous = signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


def fetch_hub(repo, revision, filename, destination, token, cache):
    # The SDK's cache/locks/metadata stay outside the clean serving directory.
    # Import here, in this disposable bootstrap process, never in the web worker.
    os.environ.setdefault("HF_HUB_DISABLE_IMPLICIT_TOKEN", "1")
    from huggingface_hub import hf_hub_download
    for attempt in range(3):
        try:
            source = hf_hub_download(
                repo_id=repo, repo_type="dataset", revision=revision,
                filename=filename, token=token, cache_dir=str(cache),
            )
            shutil.copyfile(source, destination)
            return
        except Exception as exc:
            if isinstance(exc, BootstrapError):
                raise
            status = getattr(getattr(exc, "response", None), "status_code", None)
            if status in {401, 403, 404}:
                raise BootstrapError("Dataset access/revision unavailable; check repository, commit and read-token permission") from None
            if isinstance(exc, OSError) and exc.errno == 28:
                raise BootstrapError("Insufficient Dataset cache storage") from None
            if attempt == 2:
                raise BootstrapError("Dataset download failed after bounded retries; check network/storage") from None
            time.sleep(2 ** attempt)


def prepare(env=None, fetch=fetch_hub):
    env = os.environ if env is None else env
    expected = expected_digest(env)
    mode = env.get("EXPLORER_DATA_MODE", "hub")
    root = Path(env.get("EXPLORER_RELEASE", "/data/current"))
    if mode == "local":
        # Full structural and checksum verification runs exactly once in lifespan.
        inventory(root, expected)
        return root
    if mode != "hub":
        raise BootstrapError("EXPLORER_DATA_MODE must be local or hub")
    repo, revision = env.get("EXPLORER_DATASET_REPO", ""), env.get("EXPLORER_DATASET_REVISION", "")
    prefix = env.get("EXPLORER_DATASET_DIR", "release")
    if not re.fullmatch(r"[\w.-]+/[\w.-]+", repo) or not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise BootstrapError("Hub mode requires Dataset owner/name and a full immutable 40-character commit SHA")
    if prefix != "release":
        raise BootstrapError("EXPLORER_DATASET_DIR must be release for this contract")
    cache = Path(env.get("EXPLORER_CACHE", "/data"))
    cache.mkdir(parents=True, exist_ok=True)
    identity = hashlib.sha256(f"{repo}\n{revision}\n{prefix}\n{expected}".encode()).hexdigest()
    final = cache / "releases" / identity
    final.parent.mkdir(exist_ok=True)
    root.parent.mkdir(parents=True, exist_ok=True)
    if final.exists():
        # A corrupt pinned cache fails closed rather than serving an old release.
        verify_payloads(final, expected)
    else:
        token = env.get("HF_TOKEN", "")
        if not token:
            raise BootstrapError("HF_TOKEN read access is required for a private Dataset cache miss")
        with deadline(1200), tempfile.TemporaryDirectory(prefix=".download-", dir=cache) as temporary:
            stage = Path(temporary) / "release"
            stage.mkdir()
            # One SDK call at a time; no snapshot-wide download or Xet workers.
            fetch(repo, revision, prefix + "/manifest.json", stage / "manifest.json", token, cache / "hub")
            files, total = inventory(stage, expected)
            if shutil.disk_usage(cache).free < total * 2 + 64 * 1024**2:
                raise BootstrapError("Insufficient storage for Dataset cache plus validated copy")
            for item in files:
                dest = stage / item["path"]
                dest.parent.mkdir(parents=True, exist_ok=True)
                fetch(repo, revision, prefix + "/" + item["path"], dest, token, cache / "hub")
                if dest.stat().st_size != item["bytes"] or digest(dest) != item["sha256"]:
                    raise BootstrapError("Downloaded Dataset payload failed checksum: " + item["path"])
            verify_payloads(stage, expected)
            stage.rename(final)
    # Switch only after exact payload verification. The server starts afterwards,
    # so a structural failure cannot expose any requests, even health probes.
    link = root.with_name(root.name + ".next")
    link.unlink(missing_ok=True)
    link.symlink_to(final.resolve(), target_is_directory=True)
    link.replace(root)
    return root


def main():
    try:
        root = prepare()
        print("Pinned explorer payload ready; validating publication before serving", flush=True)
    except (BootstrapError, OSError, ValueError, KeyError, TypeError) as exc:
        # Never print SDK exceptions, environment dictionaries or secret values.
        message = str(exc) if isinstance(exc, BootstrapError) else "Dataset preparation failed; check configuration, manifest and storage"
        print(message, file=sys.stderr)
        return 2
    os.environ["EXPLORER_RELEASE"] = str(root)
    os.environ.pop("HF_TOKEN", None)
    os.execvp(sys.executable, [sys.executable, "-m", "uvicorn", "hf_export.production:app",
                              "--host", "0.0.0.0", "--port", "7860", "--workers", "1",
                              "--timeout-graceful-shutdown", "20", "--no-access-log"])


if __name__ == "__main__":
    raise SystemExit(main())
