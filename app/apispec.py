"""The description of the API at /openapi.json (OpenAPI 3.1), made from the app's own table of routes
and the docstrings of its handlers, and the page for people, docs/http-api.md, made from the same.

A handler says what it does in the first line of its docstring (the summary) and the lines after it.
What a route reads from the query and what it answers comes from @api(...) beside the route:

    python3 -m app.apispec > docs/http-api.md       # the page for people, after a change of the API
"""
from __future__ import annotations

import inspect
import re
from dataclasses import dataclass

TITLE = "Planet Terrain Maker"
NOT_DESCRIBED = "Not described."


@dataclass(frozen=True)
class Param:
    """One value a route reads from the query string."""
    name: str
    kind: str            # "number", "integer" or "string"
    text: str
    required: bool = False

    def openapi(self) -> dict:
        return {"name": self.name, "in": "query", "required": self.required,
                "description": self.text, "schema": {"type": self.kind}}


def api(*query: Param, responses: dict | None = None, body: str | None = None):
    """What a route reads and answers, for its description. `responses` is {status: words}; `body`
    says what the request body is, for routes that take one."""
    def mark(handler):
        handler.__api__ = {"query": query, "responses": responses or {}, "body": body}
        return handler
    return mark


_ARG = re.compile(r"<(?:(\w+)(?:\([^)]*\))?:)?(\w+)>")


def _path_of(rule: str) -> tuple:
    """A Flask rule as an OpenAPI path, and its path parameters as (name, type)."""
    params = []

    def swap(match):
        converter, name = match.group(1) or "string", match.group(2)
        params.append((name, "integer" if converter == "int" else "number" if converter == "float" else "string"))
        return "{" + name + "}"

    return _ARG.sub(swap, rule), params


def build(app, version: str | None) -> dict:
    """The OpenAPI document of every route of `app`, pages included."""
    paths = {}
    for rule in sorted(app.url_map.iter_rules(), key=lambda r: r.rule):
        handler = app.view_functions[rule.endpoint]
        doc = inspect.getdoc(handler) or ""
        summary, _, more = doc.partition("\n")
        meta = getattr(handler, "__api__", {"query": (), "responses": {}, "body": None})
        path, path_params = _path_of(rule.rule)
        for method in sorted(rule.methods - {"HEAD", "OPTIONS"}):
            op = {
                "operationId": f"{rule.endpoint}_{method.lower()}",
                "summary": summary.strip(),
                "security": [],
                "parameters": [{"name": n, "in": "path", "required": True, "schema": {"type": t}}
                               for n, t in path_params] + [p.openapi() for p in meta["query"]],
                "responses": {str(code): {"description": words} for code, words in sorted(meta["responses"].items())}
                             or {"200": {"description": NOT_DESCRIBED}},
            }
            if more.strip():
                op["description"] = " ".join(more.split())
            if meta.get("body"):
                op["requestBody"] = {"description": meta["body"], "content": {"*/*": {}}}
            paths.setdefault(path, {})[method.lower()] = op
    return {
        "openapi": "3.1.0",
        "info": {
            "title": TITLE,
            "version": version or "working copy",
            "description": "No sign-in: every route is open to whoever reaches the server, as the page itself is. "
                           "Run it in a private network, or behind a proxy of your own that signs people in.",
        },
        "components": {"securitySchemes": {}},
        "paths": paths,
    }


def markdown(spec: dict) -> str:
    """The page for people: every route with its summary, what it reads, and what it answers."""
    lines = [f"# {spec['info']['title']}: HTTP API", "",
             "Made from `/openapi.json` by `python3 -m app.apispec`; do not edit by hand.", "",
             spec["info"]["description"], ""]
    for path, ops in spec["paths"].items():
        for method, op in ops.items():
            lines += [f"## {method.upper()} `{path}`", "", op["summary"], ""]
            if op.get("description"):
                lines += [op["description"], ""]
            for p in op["parameters"]:
                need = "required" if p["required"] else "optional"
                lines.append(f"- `{p['name']}` ({p['in']}, {p['schema']['type']}, {need})"
                             + (f": {p['description']}" if p.get("description") else ""))
            if op.get("requestBody"):
                lines.append(f"- body: {op['requestBody']['description']}")
            for code, answer in op["responses"].items():
                lines.append(f"- {code}: {answer['description']}")
            lines.append("")
    return "\n".join(lines)


if __name__ == "__main__":
    import sys
    import tempfile
    from pathlib import Path

    from .server import create_app

    with tempfile.TemporaryDirectory() as data:
        sys.stdout.write(markdown(build(create_app(Path(data)), None)))
