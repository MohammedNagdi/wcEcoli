import io
from pathlib import Path
import tarfile

import pytest

import ci_explorer_package as candidate


REVISION = "a" * 40


@pytest.fixture
def archived_candidate(tmp_path, monkeypatch):
    bundle = tmp_path / "source"
    (bundle / "space").mkdir(parents=True)
    (bundle / "space/THIRD_PARTY_NOTICES.txt").write_text("notices")
    monkeypatch.setattr(candidate.portable.host, "inputs", lambda: {})
    descriptor = candidate.portable.descriptor()
    identity = {
        "schema_version": "explorer-package-v2",
        "source_revision": REVISION,
        "release": descriptor,
        "tooling_inventory": {},
        "space_inventory": candidate.portable.host.inventory(bundle / "space"),
    }
    candidate.portable.save(
        bundle / "evidence/package.json",
        dict(
            identity,
            source_sha256=candidate.portable.fingerprint(identity),
            manifest_sha256=descriptor["dataset"]["manifest_sha256"],
        ),
    )
    archive = tmp_path / "candidate.tar.gz"
    return archive, candidate.pack(bundle, archive, REVISION)


def test_exact_candidate_round_trips(tmp_path, archived_candidate):
    archive, expected = archived_candidate
    directory = tmp_path / "verified"
    receipt = candidate.unpack(archive, directory, REVISION, **expected)
    assert receipt["source_sha256"] == expected["fingerprint"]
    assert (directory / "space/THIRD_PARTY_NOTICES.txt").read_text() == "notices"


@pytest.mark.parametrize("mismatch", ["sha256", "fingerprint", "revision"])
def test_wrong_candidate_is_not_installed(tmp_path, archived_candidate, mismatch):
    archive, expected = archived_candidate
    directory = tmp_path / "verified"
    if mismatch == "revision":
        revision = "b" * 40
    else:
        revision = REVISION
        expected[mismatch] = "b" * 64
    with pytest.raises(ValueError, match="differs"):
        candidate.unpack(archive, directory, revision, **expected)
    assert not directory.exists()


@pytest.mark.parametrize("entry", ["space/../escape", "dataset/private.h5", "space/link"])
def test_disallowed_archive_entries_are_rejected(tmp_path, entry):
    archive = tmp_path / "unexpected.tar.gz"
    with tarfile.open(archive, "w:gz") as stream:
        member = tarfile.TarInfo(entry)
        if entry == "space/link":
            member.type = tarfile.SYMTYPE
            member.linkname = str(Path("/outside"))
            stream.addfile(member)
        else:
            member.size = 4
            stream.addfile(member, io.BytesIO(b"test"))
    with pytest.raises(ValueError, match="Unexpected application archive entry"):
        candidate.unpack(archive, tmp_path / "verified", REVISION, candidate.archive_digest(archive), "a" * 64)
    assert not (tmp_path / "verified").exists()
