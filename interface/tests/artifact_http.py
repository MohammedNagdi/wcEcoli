"""Optional private-staging authentication, confined to the selected HF origin."""

import json
import os
from urllib.parse import urlsplit
import urllib.request

ORIGIN = "https://safrot-wcecoli-explorer.hf.space"


class NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # Never forward bearer credentials through an auth redirect.


def get_json(url):
    token = os.environ.get("HF_VERIFY_TOKEN")
    headers = {}
    if token:
        parsed = urlsplit(url)
        if (parsed.scheme + "://" + parsed.netloc != ORIGIN or parsed.username or parsed.password):
            raise ValueError("Private verification credentials may only reach the approved HTTPS Space origin")
        headers["Authorization"] = "Bearer " + token
    opener = urllib.request.build_opener(NoRedirects())
    with opener.open(urllib.request.Request(url, headers=headers), timeout=60) as response:
        return json.load(response)
