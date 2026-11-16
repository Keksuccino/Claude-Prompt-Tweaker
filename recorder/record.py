"""Records Claude Code's traffic with the Anthropic API for Claude Tweaker's API tab.

Runs inside mitmproxy (`mitmdump -s record.py`), started by recorder.sh. Only api.anthropic.com is decrypted (recorder.sh
passes `allow_hosts`); every other host a session or its tools reach is tunneled through untouched.

Under the recordings folder it writes:
  sessions/<session id>/index.jsonl  one summary line per exchange, which the API tab lists
  sessions/<session id>/<n>.json      one exchange: its headers, secrets removed, and its bodies as blob references
  blobs/<hh>/<sha256>.json            each distinct body part once: a system prompt, a tool list, a message, a response

Every request carries the whole conversation, so a request body is split into its parts: what earlier requests sent
already is stored once and referenced. Recording runs on a worker thread after the exchange ended, and a failure to record
only loses that record: the traffic itself is never held up or changed.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import queue
import threading
import time
from pathlib import Path
from typing import Any

from mitmproxy import ctx, http
from mitmproxy.net import encoding as content_encoding

API_HOST = "api.anthropic.com"

# Headers whose values are credentials or session cookies: kept by name, never by value.
SECRET_HEADERS = {"authorization", "x-api-key", "proxy-authorization", "cookie", "set-cookie"}

# The request body fields stored as blobs of their own: they repeat from request to request.
SHARED_FIELDS = ("system", "tools")

log = logging.getLogger("claude-tweaker-recorder")


class Recorder:

    def __init__(self) -> None:
        self.root: Path | None = None
        self.counters: dict[str, int] = {}
        self.jobs: queue.Queue[tuple[http.HTTPFlow, list[bytes], float] | None] = queue.Queue()
        self.worker = threading.Thread(target=self.work, name="recorder", daemon=True)
        self.worker.start()

    def load(self, loader: Any) -> None:
        loader.add_option("recordings", str, str(Path.home() / ".claude" / "prompt-tweaker" / "recordings"), "Where recordings are kept.")

    def configure(self, updated: set[str]) -> None:
        if "recordings" in updated:
            self.root = Path(ctx.options.recordings).expanduser()

    def responseheaders(self, flow: http.HTTPFlow) -> None:
        if not is_api(flow) or flow.response is None:
            return
        # Streams the response on to Claude Code chunk by chunk, keeping a copy: a buffered reply would arrive only once
        # complete. mitmproxy calls the function once more with an empty chunk when the response ends.
        chunks: list[bytes] = []
        flow.metadata["recorder_chunks"] = chunks

        def keep(data: bytes) -> bytes:
            if data:
                chunks.append(data)
            return data

        flow.response.stream = keep

    def response(self, flow: http.HTTPFlow) -> None:
        self.enqueue(flow)

    def error(self, flow: http.HTTPFlow) -> None:
        self.enqueue(flow)

    def enqueue(self, flow: http.HTTPFlow) -> None:
        # A stream that breaks off can end in both `response` and `error`: the exchange is recorded once.
        if is_api(flow) and not flow.metadata.get("recorder_queued"):
            flow.metadata["recorder_queued"] = True
            self.jobs.put((flow, flow.metadata.get("recorder_chunks", []), time.time()))

    def done(self) -> None:
        self.jobs.put(None)
        self.worker.join(timeout=5)

    def work(self) -> None:
        while True:
            job = self.jobs.get()
            if job is None:
                return
            try:
                self.record(*job)
            except Exception:
                log.exception("Could not record an exchange")

    def record(self, flow: http.HTTPFlow, chunks: list[bytes], ended_at: float) -> None:
        # recorder.sh creates the folder. Without it (an external drive not mounted) nothing is written: creating it
        # would put a folder where the drive mounts.
        if self.root is None or not self.root.is_dir():
            return
        request = flow.request
        request_text = request.get_text(strict=False) or ""
        request_json = parse_json(request_text)
        session = session_id(request, request_json)
        folder = self.root / "sessions" / session
        folder.mkdir(parents=True, exist_ok=True)
        number = self.next_number(session, folder)

        response = flow.response
        response_bytes = b"".join(chunks) if chunks else (response.raw_content or b"") if response is not None else b""
        response_text = decode(response_bytes, response.headers.get("content-encoding", "") if response is not None else "")
        summary = summarize(request_json, response_text)
        started = request.timestamp_start
        record = {
            "n": number,
            "at": round(started * 1000),
            "durationMs": round((ended_at - started) * 1000),
            "method": request.method,
            "path": request.path,
            "status": response.status_code if response is not None else None,
            "error": flow.error.msg if flow.error is not None else None,
            "requestBytes": len(request.raw_content or b""),
            "responseBytes": len(response_bytes),
            **summary,
        }
        exchange = {
            **record,
            "request": {"headers": headers_of(request.headers), "body": self.store_request(request_json, request_text)},
            "response": {"headers": headers_of(response.headers) if response is not None else [], "body": self.store_blob(response_text) if response_text else None},
        }
        write_text(folder / f"{number}.json", json.dumps(exchange, ensure_ascii=False))
        with open(folder / "index.jsonl", "a", encoding="utf-8") as index:
            index.write(json.dumps(record, ensure_ascii=False) + "\n")

    def next_number(self, session: str, folder: Path) -> int:
        if session not in self.counters:
            index = folder / "index.jsonl"
            self.counters[session] = sum(1 for _ in open(index, encoding="utf-8")) if index.exists() else 0
        self.counters[session] += 1
        return self.counters[session]

    def store_request(self, body: Any, text: str) -> dict[str, Any]:
        """A request body as blob references: the shared fields and every message apart, the other fields inline."""
        if not isinstance(body, dict):
            return {"text": self.store_blob(text)} if text else {}
        parts: dict[str, Any] = {"order": list(body.keys()), "fields": {}}
        for key, value in body.items():
            if key in SHARED_FIELDS:
                parts[key] = self.store_blob(canonical(value))
            elif key == "messages" and isinstance(value, list):
                parts["messages"] = [self.store_blob(canonical(message)) for message in value]
            else:
                parts["fields"][key] = value
        return parts

    def store_blob(self, text: str) -> str:
        digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
        path = self.root / "blobs" / digest[:2] / f"{digest}.json"
        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            write_text(path, text)
        return digest


def is_api(flow: http.HTTPFlow) -> bool:
    return flow.request.pretty_host == API_HOST


def session_id(request: http.Request, body: Any) -> str:
    """The Claude Code session a request belongs to: its session header, else the id in the request's metadata."""
    header = request.headers.get("x-claude-code-session-id", "")
    if header:
        return safe_name(header)
    user_id = body.get("metadata", {}).get("user_id", "") if isinstance(body, dict) and isinstance(body.get("metadata"), dict) else ""
    if isinstance(user_id, str):
        parsed = parse_json(user_id)
        if isinstance(parsed, dict) and isinstance(parsed.get("session_id"), str):
            return safe_name(parsed["session_id"])
        if "_session_" in user_id:
            return safe_name(user_id.rsplit("_session_", 1)[1])
    return "unknown"


def summarize(body: Any, response_text: str) -> dict[str, Any]:
    """What the API tab's one-liners show: model, message count, token usage and why the reply ended."""
    summary: dict[str, Any] = {"model": None, "messages": None, "isStream": False, "usage": None, "stopReason": None, "errorType": None}
    if isinstance(body, dict):
        summary["model"] = body.get("model")
        summary["isStream"] = body.get("stream") is True
        if isinstance(body.get("messages"), list):
            summary["messages"] = len(body["messages"])
    usage: dict[str, Any] = {}
    for event in response_events(response_text):
        kind = event.get("type")
        if kind == "message_start" and isinstance(event.get("message"), dict):
            message = event["message"]
            summary["model"] = message.get("model", summary["model"])
            usage.update(message.get("usage") or {})
        elif kind == "message_delta":
            usage.update({key: value for key, value in (event.get("usage") or {}).items() if value is not None})
            summary["stopReason"] = (event.get("delta") or {}).get("stop_reason", summary["stopReason"])
        elif kind == "message":
            summary["model"] = event.get("model", summary["model"])
            usage.update(event.get("usage") or {})
            summary["stopReason"] = event.get("stop_reason")
        elif kind == "error":
            summary["errorType"] = (event.get("error") or {}).get("type")
    if usage:
        summary["usage"] = {
            "input": usage.get("input_tokens"),
            "output": usage.get("output_tokens"),
            "cacheRead": usage.get("cache_read_input_tokens"),
            "cacheWrite": usage.get("cache_creation_input_tokens"),
        }
    return summary


def response_events(text: str) -> list[dict[str, Any]]:
    """The JSON objects of a response: each `data:` line of a stream, or the whole body of a plain reply."""
    whole = parse_json(text)
    if isinstance(whole, dict):
        return [whole]
    events = []
    for line in text.splitlines():
        if line.startswith("data:"):
            event = parse_json(line[5:].strip())
            if isinstance(event, dict):
                events.append(event)
    return events


def headers_of(headers: http.Headers) -> list[list[str]]:
    return [[name, "[removed]" if name.lower() in SECRET_HEADERS else value] for name, value in headers.items(multi=True)]


def decode(data: bytes, encoding: str) -> str:
    try:
        return content_encoding.decode(data, encoding).decode("utf-8", "replace") if encoding else data.decode("utf-8", "replace")
    except Exception:
        return data.decode("utf-8", "replace")


def canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def parse_json(text: str) -> Any:
    try:
        return json.loads(text)
    except (ValueError, TypeError):
        return None


def safe_name(value: str) -> str:
    """A session id as a folder name: anything but letters, digits, `-` and `_` would let it name another folder."""
    cleaned = "".join(char for char in value if char.isalnum() or char in "-_")[:100]
    return cleaned or "unknown"


def write_text(path: Path, text: str) -> None:
    # Written next to the target and renamed over it, so the API tab never reads half a file.
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(text, encoding="utf-8")
    temporary.replace(path)


addons = [Recorder()]
