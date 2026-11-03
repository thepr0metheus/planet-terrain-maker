"""The form of what the server says over HTTP, to the byte where a client could lean on it."""
import json
import socket
import unittest

from helpers import Answer, ServerCase

NOT_FOUND = b"The requested URL was not found on the server."


class FormOfAnswersTest(ServerCase):
    def test_json_is_compact_with_sorted_keys_letters_as_they_are_and_a_line_end(self):
        answer = self.server.get("/api/settings")
        self.assertEqual(answer.data, b'{"fly_preset":null,"opentopo_key":null,"starts":{}}\n')
        self.assertEqual(answer.headers["Content-Type"], "application/json")
        self.assertEqual(answer.headers["Content-Length"], str(len(answer.data)))
        made = self.server.save_model({"z": {"b": 1, "a": 2}, "name": "ბათუმი"})
        said = self.server.get(f"/api/models/{made['id']}").data.decode()
        self.assertIn('"name":"ბათუმი"', said)
        self.assertIn('"z":{"a":2,"b":1}', said)
        self.assertLess(said.index('"created"'), said.index('"name"'))

    def test_floats_are_written_as_python_writes_them(self):
        made = self.server.save_model({"name": "n", "a": 1.0, "b": 1e-7, "c": 1.5e300, "d": 0.1, "e": 5, "f": 1e22, "g": -0.0})
        said = self.server.get(f"/api/models/{made['id']}").data.decode()
        for part in ('"a":1.0', '"b":1e-07', '"c":1.5e+300', '"d":0.1', '"e":5', '"f":1e+22', '"g":-0.0'):
            with self.subTest(part=part):
                self.assertIn(part, said)

    def test_a_model_is_written_to_its_file_as_it_always_was(self):
        made = self.server.save_model({"name": "ბათუმი", "a": [1, {"b": 2.5}], "e": [], "o": {}}, {"x.bin": b"1"})
        text = (self.data / "models" / made["id"] / "meta.json").read_text()
        self.assertEqual(text, '{\n "name": "ბათუმი",\n "a": [\n  1,\n  {\n   "b": 2.5\n  }\n ],\n "e": [],\n "o": {},\n "files": {\n  "x.bin": 1\n },\n'
                               f' "id": "{made["id"]}",\n "created": "{made["created"]}",\n "updated": "{made["updated"]}"\n}}')
        self.assertRegex(made["created"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+00:00$")

    def test_the_settings_file_as_it_always_was(self):
        self.server.put("/api/settings/start/moon", {"lat": 1.5, "lon": 2, "zoom": 3})
        self.assertEqual((self.data / "settings.json").read_text(), '{\n "starts": {\n  "moon": {\n   "lat": 1.5,\n   "lon": 2.0,\n   "zoom": 3.0\n  }\n }\n}')

    def test_every_answer_says_nosniff(self):
        for path in ("/", "/healthz", "/api/settings", "/nothing-here", "/api/models/0123456789ab"):
            with self.subTest(path=path):
                self.assertEqual(self.server.get(path).headers["X-Content-Type-Options"], "nosniff")

    def test_no_such_file_is_a_page_with_the_policy(self):
        for path in ("/nothing-here", "/api/nothing", "/api/tile/earth-photo/a/1/2", "/js", "/js/", "/api/models/abc/nothing", "/healthz/", "/api/settings/"):
            with self.subTest(path=path):
                answer = self.server.get(path)
                self.assertEqual(answer.status, 404)
                self.assertEqual(answer.headers["Content-Type"], "text/html; charset=utf-8")
                self.assertIn(NOT_FOUND, answer.data)
                self.assertIn("default-src 'self'", answer.headers["Content-Security-Policy"])

    def test_a_refusal_of_the_api_has_no_policy(self):
        answer = self.server.get("/api/models/0123456789ab")
        self.assertEqual((answer.status, answer.data), (404, b'{"error":"no such model"}\n'))
        self.assertIsNone(answer.headers["Content-Security-Policy"])

    @staticmethod
    def allowed(answer) -> list:
        return sorted(word.strip() for word in answer.headers["Allow"].split(","))

    def test_a_method_a_path_does_not_take(self):
        anything = ["GET", "HEAD", "OPTIONS"]         # any path may be a file of the page
        for method, path, more in (("POST", "/healthz", []), ("PUT", "/", []), ("DELETE", "/nothing", []),
                                   ("PATCH", "/api/models", ["POST"]), ("POST", "/api/settings/fly-preset", ["PUT"]),
                                   ("DELETE", "/api/models/abc/copy", ["POST"]), ("POST", "/api/tile/earth-photo/1/0/0", [])):
            with self.subTest(method=method, path=path):
                answer = self.server.request(method, path)
                self.assertEqual(answer.status, 405)
                self.assertEqual(self.allowed(answer), sorted(anything + more))
                self.assertEqual(answer.headers["Content-Type"], "text/html; charset=utf-8")
                self.assertIn(b"Method Not Allowed", answer.data)

    def test_head_is_the_get_without_its_body(self):
        for path in ("/", "/healthz", "/api/settings", "/ui.css", "/nothing-here", "/api/models/0123456789ab"):
            with self.subTest(path=path):
                full, head = self.server.get(path), self.server.head(path)
                self.assertEqual(head.status, full.status)
                self.assertEqual(head.data, b"")
                self.assertEqual(head.headers["Content-Type"], full.headers["Content-Type"])
                self.assertEqual(head.headers["Content-Length"], str(len(full.data)))

    def test_options_says_what_a_path_takes(self):
        for path, more in (("/api/models", ["POST"]), ("/", []), ("/anything", []), ("/api/picture-sources", ["DELETE", "POST"]),
                           ("/api/models/abc", ["DELETE", "PATCH", "PUT"]), ("/api/settings/opentopo-key", ["DELETE", "PUT"])):
            with self.subTest(path=path):
                answer = self.server.options(path)
                self.assertEqual((answer.status, answer.data), (200, b""))
                self.assertEqual(self.allowed(answer), sorted(["GET", "HEAD", "OPTIONS"] + more))

    def test_the_query_is_read_as_a_form_is(self):
        self.upstream.table["/search"] = Answer(b"[]", "application/json")
        self.server.get("/api/search?q=a+b%20c%D1%8F&q=second&lang=en")
        self.assertEqual(self.upstream.asked[0], "https://nominatim.openstreetmap.org/search?format=jsonv2&q=a+b+c%D1%8F&limit=8&addressdetails=0")

    def test_a_number_of_the_query_as_python_read_it(self):
        self.upstream.table["World_Imagery"] = Answer(b"j", "image/jpeg")
        self.upstream.table["opentopography"] = Answer(b"ncols 2\nnrows 2\nxllcenter 1\nyllcenter 1\ncellsize 1\n1 2 3 4\n", "text/plain")
        self.server.put("/api/settings/opentopo-key", {"key": "0123456789abcdef0123456789abcdef"})
        for query, status in (("south=1e0&north=2&west=.5&east=5.", 200), ("south=%201&north=2&west=0&east=+5", 200), ("south=&north=2&west=0&east=5", 400),
                              ("south=1,5&north=2&west=0&east=5", 400), ("south=0x10&north=20&west=0&east=5", 400), ("south=infinity&north=2&west=0&east=5", 400)):
            with self.subTest(query=query):
                self.assertEqual(self.server.get(f"/api/earth/heights?{query}").status, status)
        self.assertEqual(self.server.get("/api/earth/heights?south=0.00001&north=1&west=0&east=1&cells=2").status, 200)
        self.assertIn("south=1e-05", self.upstream.asked[-1])

    def test_small_numbers_in_a_grid_s_box_are_written_as_python_writes_them(self):
        self.upstream.table["LRO_LOLA"] = lambda asked: Answer(b"\0\0\x80\x3f" * 4 * 96 * 96 * 4, "image/bsq")
        grid = self.server.get("/api/planet/heights?world=moon&source=trek&south=0.00001&north=1&west=0&east=1")
        self.assertEqual(grid.status, 200)
        self.assertEqual(grid.headers["X-Grid-Box"], "1e-05,1.0,0.0,1.0")

    def test_a_body_past_the_limit_is_refused_before_it_is_read(self):
        with socket.create_connection(("127.0.0.1", self.server.port), timeout=30) as sock:
            sock.sendall(b"POST /api/models HTTP/1.1\r\nHost: x\r\nContent-Type: multipart/form-data; boundary=x\r\n"
                         + f"Content-Length: {340 * 1024 * 1024 + 1}\r\n\r\n".encode())
            head = sock.recv(4096)
        self.assertTrue(head.startswith(b"HTTP/1.1 413"), head[:80])

    def raw(self, request: bytes) -> bytes:
        with socket.create_connection(("127.0.0.1", self.server.port), timeout=30) as sock:
            sock.sendall(request)
            sock.shutdown(socket.SHUT_WR)
            answer = b""
            while chunk := sock.recv(65536):
                answer += chunk
        return answer

    def test_a_body_of_a_length_that_cannot_be_known_is_refused_and_the_connection_goes(self):
        # The body would otherwise be read as the next request on the connection: one request inside another.
        hidden = b"GET /api/settings HTTP/1.1\r\nHost: x\r\n\r\n"
        for fields, status in ((b"Content-Length: 5\r\nContent-Length: 6\r\n", b" 400 "), (b"Content-Length: +5\r\n", b" 400 "),
                               (b"Transfer-Encoding: chunked\r\n", b" 411 "), (b"Content-Length: 5\r\nTransfer-Encoding: chunked\r\n", b" 411 ")):
            with self.subTest(fields=fields):
                answer = self.raw(b"POST /api/client-error HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n" + fields + b"\r\n" + hidden)
                self.assertIn(status, answer.split(b"\r\n")[0])
                self.assertEqual(answer.count(b"HTTP/1.1 "), 1, "the hidden request is not answered")
                self.assertIn(b"Connection: close", answer)
        self.assertEqual(self.server.get("/api/client-errors").json()["errors"], [])

    def test_a_head_with_no_end_is_refused_within_its_limit(self):
        # Refused at 256 KB, while the client still sends: it hears the refusal, or the connection goes under it. Either
        # way the server reads no more of it, and goes on.
        try:
            answer = self.raw(b"GET / HTTP/1.1\r\nX-Long: " + b"x" * 1_000_000)
            self.assertIn(b" 400 ", answer.split(b"\r\n")[0])
        except (ConnectionResetError, BrokenPipeError):
            pass
        self.assertEqual(self.server.get("/healthz").status, 200)

    def test_a_request_that_is_not_http_gets_a_refusal(self):
        with socket.create_connection(("127.0.0.1", self.server.port), timeout=30) as sock:
            sock.sendall(b"\x16\x03\x01 not http at all\r\n\r\n")
            head = sock.recv(4096)
        self.assertTrue(head == b"" or b" 400 " in head.split(b"\r\n")[0] or b"400" in head, head[:80])
        self.assertEqual(self.server.get("/healthz").status, 200)


class FilesOfThePageTest(ServerCase):
    def test_the_kinds_of_file(self):
        for path, kind in (("/", "text/html; charset=utf-8"), ("/index.html", "text/html; charset=utf-8"), ("/ui.css", "text/css; charset=utf-8"),
                           ("/js/app.js", "text/javascript; charset=utf-8"), ("/data/moon-names.json", "application/json"),
                           ("/favicon.svg", "image/svg+xml; charset=utf-8"), ("/vendor/three/LICENSE", "application/octet-stream")):
            with self.subTest(path=path):
                answer = self.server.get(path)
                self.assertEqual(answer.status, 200)
                self.assertEqual(answer.headers["Content-Type"], kind)
                self.assertEqual(answer.headers["Cache-Control"], "no-cache")

    def test_a_file_a_browser_has_is_not_sent_again(self):
        first = self.server.get("/js/app.js")
        tag = first.headers["ETag"]
        self.assertTrue(tag)
        again = self.server.get("/js/app.js", headers={"If-None-Match": tag})
        self.assertEqual((again.status, again.data), (304, b""))
        self.assertEqual(again.headers["ETag"], tag)
        other = self.server.get("/js/app.js", headers={"If-None-Match": '"another"'})
        self.assertEqual((other.status, other.data), (200, first.data))
        listed = self.server.get("/js/app.js", headers={"If-None-Match": f'"another", {tag}'})
        self.assertEqual(listed.status, 304)
        self.assertEqual(self.server.get("/js/app.js", headers={"If-None-Match": "*"}).status, 304)

    def test_a_file_of_a_model_is_a_file_too(self):
        made = self.server.save_model({"name": "n"}, {"place-0.bin": b"\0" * 8, "place-0.jpg": b"j", "thumb.png": b"p"})
        for name, kind in (("place-0.bin", "application/octet-stream"), ("place-0.jpg", "image/jpeg"), ("thumb.png", "image/png")):
            with self.subTest(name=name):
                answer = self.server.get(f"/api/models/{made['id']}/files/{name}")
                self.assertEqual((answer.status, answer.headers["Content-Type"]), (200, kind))
                self.assertEqual(answer.headers["Cache-Control"], "no-cache")
                self.assertEqual(self.server.get(f"/api/models/{made['id']}/files/{name}", headers={"If-None-Match": answer.headers["ETag"]}).status, 304)

    def test_nothing_outside_the_page(self):
        for path in ("/../VERSION", "/..%2FVERSION", "/%2e%2e/VERSION", "/js/../../VERSION", "/data/../../Dockerfile"):
            with self.subTest(path=path):
                self.assertEqual(self.server.get(path).status, 404)


class ApiDescriptionTest(ServerCase):
    def setUp(self):
        super().setUp()
        self.spec = self.server.get("/openapi.json").json()

    def test_every_route_is_described_with_a_summary(self):
        operations = [(path, method, op) for path, ops in self.spec["paths"].items() for method, op in ops.items()]
        self.assertEqual(len(operations), 38)
        for path, method, op in operations:
            with self.subTest(route=f"{method} {path}"):
                self.assertTrue(op["summary"], "a summary")
                self.assertEqual(op["security"], [], "open, as the app is")
                self.assertTrue(op["responses"])
                self.assertTrue(op["operationId"].endswith(f"_{method}"))
        self.assertEqual(self.spec["openapi"], "3.1.0")
        self.assertEqual(self.spec["info"]["title"], "Planet Terrain Maker")
        self.assertEqual(self.spec["info"]["version"], self.server.get("/healthz").json()["version"] or "working copy")

    def test_query_parameters_are_named(self):
        names = [p["name"] for p in self.spec["paths"]["/api/earth/heights"]["get"]["parameters"]]
        self.assertEqual(names, ["south", "north", "west", "east", "cells", "source"])
        path_params = self.spec["paths"]["/api/tile/{source}/{z}/{x}/{y}"]["get"]["parameters"]
        self.assertEqual([(p["name"], p["schema"]["type"]) for p in path_params],
                         [("source", "string"), ("z", "integer"), ("x", "integer"), ("y", "integer")])
        self.assertEqual(json.dumps(self.spec["paths"]["/api/models"]["post"]["requestBody"]["content"]), '{"*/*": {}}')


if __name__ == "__main__":
    unittest.main()
