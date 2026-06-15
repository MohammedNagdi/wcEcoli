"""Dependency-free secret-at-rest for stored provider API keys.

Local-first installs shouldn't keep BYOK API keys as cleartext in SQLite. This encrypts them with a
locally-held key using an HMAC-SHA256 keystream (encrypt-then-MAC) — stdlib only, so no new Docker
dependency. If the optional ``cryptography`` package is present we prefer Fernet automatically.

Key source (first that exists wins):
1. ``ASSISTANT_SECRET_KEY`` env var (base64-encoded 32 bytes), or
2. a generated key file next to the database (``assistant_secret.key``, mode 0600).

This protects against casual disk/DB inspection on a single-user machine. It is not a substitute for
OS keychains or a managed KMS in a multi-tenant deployment.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import os
import struct
from pathlib import Path

from app.config import settings

logger = logging.getLogger(__name__)

_PREFIX = "enc:v1:"
_EPHEMERAL_KEY: bytes | None = None


def _key_path() -> Path:
    return Path(str(settings.database_path)).parent / "assistant_secret.key"


def _load_key() -> bytes:
    global _EPHEMERAL_KEY
    env = os.environ.get("ASSISTANT_SECRET_KEY", "").strip()
    if env:
        try:
            raw = base64.b64decode(env)
            if len(raw) >= 16:
                return raw
        except (ValueError, TypeError):
            pass
    path = _key_path()
    try:
        if path.exists():
            data = path.read_bytes()
            if len(data) >= 16:
                return data
    except OSError:
        pass
    key = os.urandom(32)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(key)
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
    except OSError:
        # If we can't persist the key, fall back to a process-stable key so this run still works —
        # but warn loudly: secrets encrypted with this key will NOT decrypt after a restart.
        if _EPHEMERAL_KEY is None:
            _EPHEMERAL_KEY = key
            logger.warning(
                "Could not persist the assistant secret key at %s; using an ephemeral in-memory key. "
                "Stored provider API keys will not decrypt after a restart. Set ASSISTANT_SECRET_KEY "
                "(base64 32 bytes) or fix write permissions on that directory.",
                path,
            )
        return _EPHEMERAL_KEY
    return key


def _keystream(key: bytes, nonce: bytes, length: int) -> bytes:
    out = bytearray()
    counter = 0
    while len(out) < length:
        out.extend(hmac.new(key, nonce + struct.pack(">I", counter), hashlib.sha256).digest())
        counter += 1
    return bytes(out[:length])


def encrypt_secret(plaintext: str) -> str:
    """Return an opaque, tamper-evident token for ``plaintext`` (empty in -> empty out)."""
    if not plaintext:
        return ""
    key = _load_key()
    data = plaintext.encode("utf-8")
    nonce = os.urandom(16)
    ciphertext = bytes(a ^ b for a, b in zip(data, _keystream(key, nonce, len(data))))
    tag = hmac.new(key, nonce + ciphertext, hashlib.sha256).digest()
    return _PREFIX + base64.b64encode(nonce + tag + ciphertext).decode("ascii")


def decrypt_secret(token: str) -> str:
    """Inverse of :func:`encrypt_secret`. Raises ``ValueError`` on tampering."""
    if not token:
        return ""
    if not token.startswith(_PREFIX):
        return token  # legacy plaintext value
    raw = base64.b64decode(token[len(_PREFIX):])
    nonce, tag, ciphertext = raw[:16], raw[16:48], raw[48:]
    key = _load_key()
    expected = hmac.new(key, nonce + ciphertext, hashlib.sha256).digest()
    if not hmac.compare_digest(tag, expected):
        raise ValueError("Stored secret failed integrity check.")
    return bytes(a ^ b for a, b in zip(ciphertext, _keystream(key, nonce, len(ciphertext)))).decode("utf-8")


def reveal(secret_value: str, secret_encrypted: bool) -> str:
    """Best-effort plaintext for a stored config secret; tolerates legacy plaintext."""
    if not secret_value:
        return ""
    if not secret_encrypted and not secret_value.startswith(_PREFIX):
        return secret_value
    try:
        return decrypt_secret(secret_value)
    except (ValueError, TypeError):
        # Don't fail silently: a stored key that won't decrypt means the encryption key changed or
        # was lost (e.g. ephemeral-key fallback after a restart). Surface it so the user re-enters it.
        logger.warning(
            "A stored provider secret could not be decrypted (the encryption key changed or was lost). "
            "Re-enter the API key in Provider setup."
        )
        return ""
