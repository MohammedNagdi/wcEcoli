from pathlib import Path
from tempfile import TemporaryDirectory

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlmodel import SQLModel, Session, create_engine

from app.config import settings
from app.db.models import Condition, MediaRecipe, Timeline
from app.main import get_session
from app.routers.builder_drafts import router


def _build_client():
    tempdir = TemporaryDirectory()
    engine = create_engine(f"sqlite:///{tempdir.name}/test.db", echo=False)
    SQLModel.metadata.create_all(engine)
    _seed_reconstruction(Path(tempdir.name))
    with Session(engine) as session:
        session.add(MediaRecipe(media_id='minimal', base_media='MIX0-57', added_media='', ingredients='[]'))
        session.add(Condition(name='basal', nutrients='minimal', doubling_time=44.0, active_tfs='[]', inactive_tfs='[]'))
        session.add(Timeline(name='000000_basal', definition='0 minimal'))
        session.commit()

    app = FastAPI()

    def override_get_session():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override_get_session
    app.include_router(router)
    client = TestClient(app)
    return tempdir, client


def _seed_reconstruction(root: Path):
    condition_dir = root / 'ecoli' / 'flat' / 'condition'
    media_dir = condition_dir / 'media'
    media_dir.mkdir(parents=True, exist_ok=True)
    (media_dir / 'MIX0-57.tsv').write_text(
        '"molecule id"\t"concentration (units.mmol / units.L)"\nGLC\t10\n',
        encoding='utf-8',
    )
    condition_dir.joinpath('environment_molecules.tsv').write_text(
        '# formula weight is in  (units.g / units.mol)\n'
        '"molecule id"\t"exchange molecule location"\t"formula weight"\n'
        'GLC\t[p]\tNone\n',
        encoding='utf-8',
    )
    condition_dir.joinpath('media_recipes.tsv').write_text(
        '"media id"\t"base media"\t"base media volume (units.L)"\t"added media"\t"added media volume (units.L)"\t"ingredients"\t"ingredients weight (units.g)"\t"ingredients counts (units.mmol)"\t"ingredients volume (units.L)"\n'
        'minimal\tMIX0-57\t1.0\t\t0\t[]\t[]\t[]\t[]\n',
        encoding='utf-8',
    )
    condition_dir.joinpath('condition_defs.tsv').write_text(
        '"condition"\t"nutrients"\t"genotype perturbations"\t"doubling time (units.min)"\t"active TFs"\t"inactive TFs"\n'
        'basal\tminimal\t{}\t44.0\t[]\t[]\n',
        encoding='utf-8',
    )
    condition_dir.joinpath('tf_condition.tsv').write_text(
        '"TF"\t"active TF"\t"active nutrients"\t"active genotype perturbations"\t"inactive nutrients"\t"inactive genotype perturbations"\t"TF type"\n',
        encoding='utf-8',
    )
    condition_dir.joinpath('timelines_def.tsv').write_text(
        '"timeline"\t"events"\n000000_basal\t0 minimal\n',
        encoding='utf-8',
    )


class _SettingsOverride:
    def __init__(self, reconstruction_path: Path):
        self.reconstruction_path = reconstruction_path
        self._original = settings.reconstruction_path

    def __enter__(self):
        settings.reconstruction_path = self.reconstruction_path
        return self

    def __exit__(self, exc_type, exc, tb):
        settings.reconstruction_path = self._original


def test_create_update_delete_builder_draft_round_trip():
    tempdir, client = _build_client()
    try:
        with _SettingsOverride(Path(tempdir.name)):
            create_response = client.post(
                "/api/builder-drafts/media",
                json={
                    "name": "starter-media",
                    "payload": {"draftMediaStockName": "MY_NEW_MIX", "rows": [{"molecule_id": "GLC", "concentration": "10"}]},
                },
            )
            assert create_response.status_code == 200
            created = create_response.json()
            assert created["section"] == "media"
            assert created["name"] == "starter-media"
            assert created["payload"]["draftMediaStockName"] == "MY_NEW_MIX"

            list_response = client.get("/api/builder-drafts")
            assert list_response.status_code == 200
            grouped = list_response.json()
            assert len(grouped["media"]) == 1
            assert grouped["mediaRecipe"] == []

            update_response = client.put(
                f"/api/builder-drafts/media/{created['id']}",
                json={
                    "name": "starter-media-v2",
                    "payload": {"draftMediaStockName": "MY_NEW_MIX", "rows": [{"molecule_id": "GLC", "concentration": "20"}]},
                },
            )
            assert update_response.status_code == 200
            updated = update_response.json()
            assert updated["name"] == "starter-media-v2"
            assert updated["payload"]["rows"][0]["concentration"] == "20"

            delete_response = client.delete(f"/api/builder-drafts/media/{created['id']}")
            assert delete_response.status_code == 204

            final_list = client.get("/api/builder-drafts/media")
            assert final_list.status_code == 200
            assert final_list.json() == []
    finally:
        tempdir.cleanup()


def test_duplicate_names_conflict_within_section_only():
    tempdir, client = _build_client()
    try:
        with _SettingsOverride(Path(tempdir.name)):
            first = client.post(
                "/api/builder-drafts/condition",
                json={"name": "acetate-shift", "payload": {"condition": "acetate_shift"}},
            )
            assert first.status_code == 200

            duplicate = client.post(
                "/api/builder-drafts/condition",
                json={"name": "acetate-shift", "payload": {"condition": "acetate_shift_v2"}},
            )
            assert duplicate.status_code == 409

            other_section = client.post(
                "/api/builder-drafts/timeline",
                json={"name": "acetate-shift", "payload": {"draftTimelineName": "000001_acetate_shift"}},
            )
            assert other_section.status_code == 200
    finally:
        tempdir.cleanup()


def test_preview_media_publish_reports_rows_without_writing_files():
    tempdir, client = _build_client()
    root = Path(tempdir.name)
    media_path = root / 'ecoli' / 'flat' / 'condition' / 'media' / 'PREVIEW_MIX.tsv'
    environment_path = root / 'ecoli' / 'flat' / 'condition' / 'environment_molecules.tsv'
    original_environment = environment_path.read_text(encoding='utf-8')

    try:
        with _SettingsOverride(root):
            draft = client.post(
                "/api/builder-drafts/media",
                json={
                    "name": "preview-medium",
                    "payload": {
                        "mode": "create",
                        "draft_name": "PREVIEW_MIX",
                        "rows": [
                            {"molecule_id": "GLC", "concentration": "20"},
                            {"molecule_id": "PREVIEW_SRC", "concentration": "5"},
                        ],
                        "environment_rows": [
                            {
                                "molecule_id": "PREVIEW_SRC",
                                "exchange_molecule_location": "[p]",
                                "formula_weight": "None",
                            }
                        ],
                    },
                },
            ).json()

            preview = client.get(f"/api/builder-drafts/media/{draft['id']}/preview")
            assert preview.status_code == 200
            payload = preview.json()
            assert payload["section"] == "media"
            assert payload["draft_name"] == "preview-medium"
            assert payload["warnings"] == []

            changes = {change["file"]: change for change in payload["changes"]}
            assert changes["condition/environment_molecules.tsv"]["action"] == "append"
            assert "PREVIEW_SRC\t[p]\tNone" in changes["condition/environment_molecules.tsv"]["rows"]
            assert changes["condition/media/PREVIEW_MIX.tsv"]["action"] == "create"
            assert "GLC\t20" in changes["condition/media/PREVIEW_MIX.tsv"]["rows"]

            assert not media_path.exists()
            assert environment_path.read_text(encoding='utf-8') == original_environment
    finally:
        tempdir.cleanup()


def test_preview_media_publish_surfaces_existing_file_warning():
    tempdir, client = _build_client()
    try:
        with _SettingsOverride(Path(tempdir.name)):
            draft = client.post(
                "/api/builder-drafts/media",
                json={
                    "name": "duplicate-medium",
                    "payload": {
                        "mode": "create",
                        "draft_name": "MIX0-57",
                        "rows": [{"molecule_id": "GLC", "concentration": "10"}],
                    },
                },
            ).json()

            preview = client.get(f"/api/builder-drafts/media/{draft['id']}/preview")
            assert preview.status_code == 200
            payload = preview.json()
            assert payload["changes"][0]["file"] == "condition/media/MIX0-57.tsv"
            assert payload["changes"][0]["action"] == "create"
            assert payload["warnings"] == ["Growth medium 'MIX0-57' already exists and publish will be rejected."]
    finally:
        tempdir.cleanup()


def test_publish_flow_updates_files_and_marks_draft_published():
    tempdir, client = _build_client()
    root = Path(tempdir.name)
    try:
        with _SettingsOverride(root):
            media = client.post(
                "/api/builder-drafts/media",
                json={
                    "name": "custom-medium",
                    "payload": {
                        "mode": "create",
                        "draft_name": "MY_NEW_MIX",
                        "rows": [
                            {"molecule_id": "GLC", "concentration": "20"},
                            {"molecule_id": "MY_CARBON_SRC", "concentration": "5"},
                        ],
                        "environment_rows": [
                            {
                                "molecule_id": "MY_CARBON_SRC",
                                "exchange_molecule_location": "[p]",
                                "formula_weight": "None",
                            }
                        ],
                    },
                },
            ).json()
            published_media = client.post(f"/api/builder-drafts/media/{media['id']}/publish")
            assert published_media.status_code == 200
            assert published_media.json()["status"] == "published"
            assert (root / 'ecoli' / 'flat' / 'condition' / 'media' / 'MY_NEW_MIX.tsv').exists()

            recipe = client.post(
                "/api/builder-drafts/mediaRecipe",
                json={
                    "name": "custom-recipe",
                    "payload": {
                        "mode": "create",
                        "draft": {
                            "media_id": "my_new_media",
                            "base_media": "MY_NEW_MIX",
                            "base_media_volume": "1.0",
                            "added_media": "",
                            "added_media_volume": "0",
                            "ingredients": '["MY_CARBON_SRC"]',
                            "ingredients_weight": '[]',
                            "ingredients_counts": '[Infinity]',
                            "ingredients_volume": '[]',
                        },
                    },
                },
            ).json()
            assert client.post(f"/api/builder-drafts/mediaRecipe/{recipe['id']}/publish").status_code == 200

            condition = client.post(
                "/api/builder-drafts/condition",
                json={
                    "name": "custom-condition",
                    "payload": {
                        "mode": "create",
                        "draft": {
                            "condition": "my_condition",
                            "nutrients": "my_new_media",
                            "genotype_perturbations": '{}',
                            "doubling_time": '55',
                            "active_tfs": '[]',
                            "inactive_tfs": '[]',
                        },
                    },
                },
            ).json()
            assert client.post(f"/api/builder-drafts/condition/{condition['id']}/publish").status_code == 200

            tf_rule = client.post(
                "/api/builder-drafts/tfCondition",
                json={
                    "name": "custom-tf",
                    "payload": {
                        "mode": "create",
                        "draft": [
                            {
                                "tf": "crp",
                                "active_tf": "CPLX0-226",
                                "active_nutrients": "my_new_media",
                                "active_genotype_perturbations": '{}',
                                "inactive_nutrients": "minimal",
                                "inactive_genotype_perturbations": '{}',
                                "tf_type": "1CS",
                            }
                        ],
                    },
                },
            ).json()
            assert client.post(f"/api/builder-drafts/tfCondition/{tf_rule['id']}/publish").status_code == 200

            timeline = client.post(
                "/api/builder-drafts/timeline",
                json={
                    "name": "custom-timeline",
                    "payload": {
                        "mode": "create",
                        "name": "000999_custom",
                        "events": "0 my_new_media",
                    },
                },
            ).json()
            timeline_publish = client.post(f"/api/builder-drafts/timeline/{timeline['id']}/publish")
            assert timeline_publish.status_code == 200
            assert timeline_publish.json()["published_name"] == "000999_custom"

            media_recipe_file = (root / 'ecoli' / 'flat' / 'condition' / 'media_recipes.tsv').read_text(encoding='utf-8')
            assert 'my_new_media\tMY_NEW_MIX' in media_recipe_file

            condition_file = (root / 'ecoli' / 'flat' / 'condition' / 'condition_defs.tsv').read_text(encoding='utf-8')
            assert 'my_condition\tmy_new_media' in condition_file

            tf_file = (root / 'ecoli' / 'flat' / 'condition' / 'tf_condition.tsv').read_text(encoding='utf-8')
            assert 'crp\tCPLX0-226\tmy_new_media' in tf_file

            timeline_file = (root / 'ecoli' / 'flat' / 'condition' / 'timelines_def.tsv').read_text(encoding='utf-8')
            assert '000999_custom\t0 my_new_media' in timeline_file
    finally:
        tempdir.cleanup()
