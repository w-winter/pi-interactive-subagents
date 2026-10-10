#!/usr/bin/env bash
# Preserve the response from a PIS-managed Claude Stop without changing its completion policy.
set -euo pipefail
[ -n "${PI_SUBAGENT_RUN:-}" ] || exit 0
python3 -c '
import json
import math
import os
import sys
import tempfile
from pathlib import Path


def publish(path, payload, replace=False):
    descriptor, temporary = tempfile.mkstemp(prefix="." + path.name, dir=path.parent)
    try:
        with os.fdopen(descriptor, "w") as stream:
            json.dump(payload, stream)
        if replace:
            os.replace(temporary, path)
        else:
            try:
                os.link(temporary, path)
            except FileExistsError:
                with path.open() as stream:
                    original = json.load(stream)
                if original.get("id") != payload["id"]:
                    raise ValueError("Existing completion belongs to another execution")
                timestamp = original.get("recordedAt")
                if type(timestamp) not in (int, float) or not math.isfinite(timestamp) or timestamp < 0:
                    raise ValueError("Invalid retained completion timestamp")
                if original.get("reason") not in ("done", "quit", "sentinel", "interrupted"):
                    raise ValueError("Invalid retained Claude completion reason")
                output = original.get("output")
                if not isinstance(output, dict) or output.get("cli") != "claude":
                    raise ValueError("Invalid retained Claude output")
                if "text" not in output or (output["text"] is not None and not isinstance(output["text"], str)):
                    raise ValueError("Invalid retained Claude text")
                if "transcriptPath" not in output:
                    raise ValueError("Missing retained Claude transcript path")
                transcript = output["transcriptPath"]
                if transcript is not None and (not isinstance(transcript, str) or not Path(transcript).is_absolute()):
                    raise ValueError("Invalid retained Claude transcript path")
                if original["reason"] == "sentinel":
                    status = original.get("exitCode")
                    if type(status) is not int or status < 0:
                        raise ValueError("Invalid retained shell status")
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


try:
    packet = json.load(sys.stdin)
    if packet.get("stop_hook_active", False):
        sys.exit(0)
    context = json.loads(os.environ["PI_SUBAGENT_RUN"])
    if context["cli"] != "claude":
        raise ValueError("Stop hook requires a Claude run context")
    run_dir = Path(context["runDir"])
    if not run_dir.is_absolute():
        raise ValueError("Run directory must be absolute")
    identity = os.environ["PI_SUBAGENT_ID"]
    transcript = Path(packet.get("transcript_path", ""))
    if not transcript.is_absolute() or not transcript.is_file():
        raise ValueError("Missing Claude transcript")
    text = packet.get("last_assistant_message", "")
    if not isinstance(text, str):
        raise ValueError("Invalid Claude response")
    count = 0
    with transcript.open() as stream:
        for line in stream:
            if not line.strip():
                continue
            entry = json.loads(line)
            if entry.get("type") == "user" and isinstance(entry.get("message", {}).get("content"), str):
                count += 1
    publish(run_dir / "response.json", {"id": identity, "text": text, "transcriptPath": str(transcript)}, replace=True)
    if count == 1:
        import time
        publish(run_dir / "completion.json", {
            "id": identity, "recordedAt": time.time() * 1000, "reason": "done",
            "output": {"cli": "claude", "text": text, "transcriptPath": str(transcript)},
        })
except Exception as error:
    print("[subagents:completion-file] " + json.dumps({"event": "claude_publication_failed", "error": type(error).__name__}), file=sys.stderr)
    sys.exit(1)
'
