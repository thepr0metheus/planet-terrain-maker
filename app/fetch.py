"""Requests to the services the app takes its data from: one place that sets who we say we are, how
long we wait, and what a failure looks like.

The services are other people's: map tiles (Esri, EOX, NASA Trek, AWS), heights (OpenTopography,
Trek, USGS), names (Nominatim) and buildings (Overpass). Tests give the app a fake in its place.
"""
from __future__ import annotations

import http.client
import os
import socket
import urllib.error
import urllib.request

# Nominatim and Overpass ask every application to say who it is: APP_USER_AGENT may add a way to
# reach whoever runs this copy (an address or a page), as their usage policies ask.
USER_AGENT = os.environ.get("APP_USER_AGENT", "planet-terrain-maker/1.0")


class FetchError(Exception):
    """A service did not give what was asked. `status` is its HTTP status, or None when it did
    not answer at all (network, timeout)."""

    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


class Answer:
    """What a service sent: the body, its type, and the status."""

    def __init__(self, body: bytes, content_type: str, status: int = 200):
        self.body = body
        self.content_type = content_type
        self.status = status


class Fetcher:
    """GET and POST with our name on them. A status of 400 and more is a FetchError, so that a
    caller never mistakes an error page for data."""

    def __init__(self, timeout: float = 60.0):
        self.timeout = timeout

    def get(self, url: str, headers: dict | None = None, timeout: float | None = None) -> Answer:
        return self._send(urllib.request.Request(url, headers=self._headers(headers)), timeout)

    def post(self, url: str, data: bytes, headers: dict | None = None, timeout: float | None = None) -> Answer:
        return self._send(urllib.request.Request(url, data=data, headers=self._headers(headers), method="POST"), timeout)

    @staticmethod
    def _headers(extra: dict | None) -> dict:
        return {"User-Agent": USER_AGENT, **(extra or {})}

    def _send(self, request: urllib.request.Request, timeout: float | None) -> Answer:
        try:
            with urllib.request.urlopen(request, timeout=timeout or self.timeout) as resp:
                return Answer(resp.read(), resp.headers.get("Content-Type", ""), resp.status)
        except urllib.error.HTTPError as e:
            raise FetchError(f"HTTP {e.code}", e.code) from None
        except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError,
                http.client.HTTPException, OSError) as e:
            reason = getattr(e, "reason", None) or e
            raise FetchError(f"no answer: {reason}") from None
