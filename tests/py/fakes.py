"""Stand-ins for the outside world in the server's tests."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from app.fetch import Answer, FetchError  # noqa: E402


class FakeFetcher:
    """Answers from a table: {url part: Answer or FetchError or callable(url) -> Answer}. The first
    entry whose key is in the URL answers; a URL no key matches fails the test."""

    def __init__(self, table=None):
        self.table = dict(table or {})
        self.asked = []

    def _answer(self, url):
        self.asked.append(url)
        for part, answer in self.table.items():
            if part in url:
                if callable(answer) and not isinstance(answer, (Answer, FetchError)):
                    answer = answer(url)
                if isinstance(answer, FetchError):
                    raise answer
                return answer
        raise AssertionError(f"nothing in the fake answers {url}")

    def get(self, url, headers=None, timeout=None):
        return self._answer(url)

    def post(self, url, data, headers=None, timeout=None):
        return self._answer(url)


class Clock:
    """Time that moves only when told to."""

    def __init__(self, now=1_000_000.0):
        self.now = now

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds
