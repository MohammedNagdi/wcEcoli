import io
import json
import urllib.error
import urllib.parse

import pytest

import ci_verify_explorer as verification


def test_oidc_exchanges_for_the_dataset_resource(monkeypatch, capsys):
    monkeypatch.setenv("ACTIONS_ID_TOKEN_REQUEST_URL", "https://example.test/oidc?api-version=2")
    monkeypatch.setenv("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "request-fixture")
    requests = []
    responses = iter([{"value": "identity-fixture"}, {"access_token": "credential-fixture"}])

    def urlopen(request, timeout):
        requests.append(request)
        return io.BytesIO(json.dumps(next(responses)).encode())

    monkeypatch.setattr(verification.urllib.request, "urlopen", urlopen)
    assert verification.mint_dataset_token("Safrot/wcecoli-demo-v1") == "credential-fixture"
    query = urllib.parse.parse_qs(urllib.parse.urlsplit(requests[0].full_url).query)
    assert query == {"api-version": ["2"], "audience": ["https://huggingface.co"]}
    assert requests[1].full_url == "https://huggingface.co/oauth/token"
    body = json.loads(requests[1].data)
    assert body["resource"] == "datasets/Safrot/wcecoli-demo-v1"
    assert body["subject_token"] == "identity-fixture"
    assert capsys.readouterr().out == "::add-mask::credential-fixture\n"


def test_oidc_rejection_omits_remote_error_details(monkeypatch, capsys):
    monkeypatch.setenv("ACTIONS_ID_TOKEN_REQUEST_URL", "https://example.test/oidc")
    monkeypatch.setenv("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "request-fixture")

    def reject(request, timeout):
        raise urllib.error.URLError("private diagnostic")

    monkeypatch.setattr(verification.urllib.request, "urlopen", reject)
    with pytest.raises(RuntimeError, match="^Hugging Face Dataset identity exchange failed$"):
        verification.mint_dataset_token("Safrot/wcecoli-demo-v1")
    assert not capsys.readouterr().out
