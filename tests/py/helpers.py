"""The server under test, reached over HTTP alone: a process of its own, with its own data folder and
port, and a fake of the outside world behind it. The binary asks the fake in place of the real services
when it is built with the feature test-upstream, which the image never has:

    cargo build -p planet-terrain-maker --features test-upstream
"""
from __future__ import annotations

import http.client
import json
import os
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import unittest
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BINARY = ROOT / "target" / "debug" / "planet-terrain-maker"
UNSET = object()


class Answer:
    """What a fake service sends."""

    def __init__(self, body: bytes = b"", content_type: str = "application/octet-stream", status: int = 200):
        self.body = body
        self.content_type = content_type
        self.status = status


class Asked:
    """One request a fake service got."""

    def __init__(self, method: str, url: str, headers, body: bytes):
        self.method = method
        self.url = url
        self.headers = headers
        self.body = body


class FakeServices(ThreadingHTTPServer):
    """As many connections at once as the server opens: the finer Moon file takes 16."""
    request_queue_size = 128
    daemon_threads = True


class Upstream:
    """The services, faked: {a part of the URL: Answer, or a status to fail with, or DROP, or a function
    of the Asked that gives one of these}. The first key found in the URL answers. A URL no key finds
    goes to `unexpected`, and ServerCase fails the test on it."""

    DROP = "the connection closes with no answer"

    def __init__(self, table: dict | None = None):
        self.table = dict(table or {})
        self.requests: list[Asked] = []
        self.unexpected: list[str] = []
        self._lock = threading.Lock()
        upstream = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def _serve(self):
                size = int(self.headers.get("Content-Length") or 0)
                asked = Asked(self.command, "https://" + self.path.removeprefix("/"), self.headers, self.rfile.read(size))
                answer = upstream.answer(asked)
                if answer == Upstream.DROP:
                    self.close_connection = True
                    return
                if isinstance(answer, int):
                    answer = Answer(b"", "text/plain", answer)
                self.send_response(answer.status)
                self.send_header("Content-Type", answer.content_type)
                self.send_header("Content-Length", str(len(answer.body)))
                self.end_headers()
                self.wfile.write(answer.body)

            do_GET = do_POST = _serve

        self._server = FakeServices(("127.0.0.1", 0), Handler)
        self.address = f"127.0.0.1:{self._server.server_address[1]}"
        threading.Thread(target=self._server.serve_forever, daemon=True).start()

    @property
    def asked(self) -> list[str]:
        """The URLs asked, in their order, as the server named them."""
        with self._lock:
            return [request.url for request in self.requests]

    def answer(self, asked: Asked):
        with self._lock:
            self.requests.append(asked)
            items = list(self.table.items())
        for part, answer in items:
            if part in asked.url:
                return answer(asked) if callable(answer) else answer
        with self._lock:
            self.unexpected.append(asked.url)
        return 599

    def close(self):
        self._server.shutdown()
        self._server.server_close()


class Reply:
    """What the server answered."""

    def __init__(self, status: int, headers, data: bytes):
        self.status = status
        self.headers = headers
        self.data = data

    @property
    def mimetype(self) -> str:
        return (self.headers.get("Content-Type") or "").split(";")[0].strip()

    def json(self):
        return json.loads(self.data)


class Multipart:
    """A multipart/form-data body, as a browser sends one: fields, and files under their field's name."""

    @staticmethod
    def of(form: dict | None, files: dict | None) -> tuple[bytes, str]:
        boundary = f"----ptm{uuid.uuid4().hex}"
        out = bytearray()
        for name, value in (form or {}).items():
            out += f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n'.encode()
            out += value.encode() + b"\r\n"
        for name, body in (files or {}).items():
            out += (f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; filename="{name}"\r\n'
                    "Content-Type: application/octet-stream\r\n\r\n").encode()
            out += body + b"\r\n"
        out += f"--{boundary}--\r\n".encode()
        return bytes(out), f"multipart/form-data; boundary={boundary}"


class Server:
    """One server process. Its data folder stays when it stops, for another to start on."""

    def __init__(self, upstream: Upstream, data: Path, env: dict | None = None):
        self.upstream = upstream
        self.data = Path(data)
        self.env = dict(env or {})
        self.log_path = self.data.parent / f"server-{uuid.uuid4().hex}.log"
        self.process = None
        self.port = None
        self.start()

    @staticmethod
    def _free_port() -> int:
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            return probe.getsockname()[1]

    @staticmethod
    def _command() -> list[str]:
        if not BINARY.exists():
            raise RuntimeError(f"no {BINARY}: cargo build -p planet-terrain-maker --features test-upstream")
        return [str(BINARY)]

    def start(self):
        self.port = self._free_port()
        env = {"PATH": os.environ.get("PATH", ""), "TZ": "UTC", "APP_HOST": "127.0.0.1", "APP_PORT": str(self.port),
               "APP_DATA": str(self.data), "PTM_TEST_UPSTREAM": self.upstream.address, **self.env}
        with self.log_path.open("ab") as log:
            self.process = subprocess.Popen(self._command(), cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
        for _ in range(600):
            if self.process.poll() is not None:
                raise RuntimeError(f"the server stopped with {self.process.returncode}:\n{self.log()}")
            try:
                if self.get("/healthz").status == 200:
                    return
            except OSError:
                pass
            time.sleep(0.05)
        raise RuntimeError(f"the server did not answer:\n{self.log()}")

    def stop(self):
        if self.process:
            self.process.terminate()
            self.process.wait(timeout=10)
            self.process = None

    def restart(self):
        self.stop()
        self.start()

    def log(self) -> str:
        return self.log_path.read_text(errors="replace")

    # ---------- asking ----------

    def request(self, method: str, path: str, body: bytes | None = None, headers: dict | None = None) -> Reply:
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=120)
        try:
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            return Reply(response.status, response.headers, response.read())
        finally:
            connection.close()

    def _send(self, method, path, json_body=UNSET, data=None, content_type=None, form=None, files=None, headers=None) -> Reply:
        headers = dict(headers or {})
        if json_body is not UNSET:
            data, content_type = json.dumps(json_body).encode(), "application/json"
        elif form is not None or files is not None:
            data, content_type = Multipart.of(form, files)
        if content_type:
            headers["Content-Type"] = content_type
        return self.request(method, path, body=data, headers=headers)

    def get(self, path: str, headers: dict | None = None) -> Reply:
        return self.request("GET", path, headers=headers)

    def head(self, path: str, headers: dict | None = None) -> Reply:
        return self.request("HEAD", path, headers=headers)

    def options(self, path: str) -> Reply:
        return self.request("OPTIONS", path)

    def delete(self, path: str, json_body=UNSET) -> Reply:
        return self._send("DELETE", path, json_body=json_body)

    def post(self, path: str, json_body=UNSET, **kwargs) -> Reply:
        return self._send("POST", path, json_body=json_body, **kwargs)

    def put(self, path: str, json_body=UNSET, **kwargs) -> Reply:
        return self._send("PUT", path, json_body=json_body, **kwargs)

    def patch(self, path: str, json_body=UNSET, **kwargs) -> Reply:
        return self._send("PATCH", path, json_body=json_body, **kwargs)

    def save_model(self, meta: dict, files: dict | None = None) -> dict:
        """A new model, saved as the page saves one."""
        answer = self.post("/api/models", form={"meta": json.dumps(meta)}, files=files or {})
        if answer.status != 201:
            raise AssertionError(f"the model was not saved: {answer.status} {answer.data[:300]!r}")
        return answer.json()


class ServerCase(unittest.TestCase):
    """A test with a server of its own. SERVICES is the table of its fake services."""

    SERVICES: dict = {}
    ENV: dict = {}

    def setUp(self):
        self.home = Path(tempfile.mkdtemp(prefix="ptm-test-"))
        self.addCleanup(shutil.rmtree, self.home, ignore_errors=True)
        self.upstream = Upstream(self.SERVICES)
        self.addCleanup(self.upstream.close)
        self.data = self.home / "data"
        self.data.mkdir()
        self.server = self.new_server()
        self.addCleanup(self.check_nothing_unexpected)

    def new_server(self, upstream: Upstream | None = None, data: Path | None = None, env: dict | None = None) -> Server:
        server = Server(upstream or self.upstream, data or self.data, {**self.ENV, **(env or {})})
        self.addCleanup(server.stop)
        return server

    def check_nothing_unexpected(self):
        self.assertEqual(self.upstream.unexpected, [], "the server asked for what no fake service answers")
