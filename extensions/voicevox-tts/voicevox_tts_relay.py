#!/usr/bin/env python3
"""Relay a Claude Code hook payload to the host VOICEVOX TTS extension."""

import json
import os
import pathlib
import sys
import urllib.error
import urllib.request


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, OSError) as exc:
        print(f"VOICEVOX relay: invalid hook input: {exc}", file=sys.stderr)
        return 1

    text = payload.get("last_assistant_message") or payload.get("message") or ""
    if not isinstance(text, str) or not text.strip():
        return 0

    token_path = pathlib.Path.home() / ".claude" / "hooks" / "voicevox_relay_token"
    try:
        token = token_path.read_text(encoding="utf-8").strip()
    except OSError as exc:
        print(f"VOICEVOX relay: cannot read {token_path}: {exc}", file=sys.stderr)
        return 1

    host = os.environ.get("VOICEVOX_RELAY_HOST", "host.docker.internal:50022").rstrip("/")
    if not host.startswith(("http://", "https://")):
        host = "http://" + host
    body = json.dumps({"text": text}, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        host + "/speak",
        data=body,
        headers={
            "Content-Type": "application/json",
            "X-VOICEVOX-Relay-Token": token,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            response.read()
    except (urllib.error.URLError, TimeoutError) as exc:
        print(f"VOICEVOX relay: request failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
