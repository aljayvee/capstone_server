"""
Fetching for the crawler: polite, cached, and honest about who is asking.

"More effective" here means more data per request and fewer requests wasted,
never getting past a site that has said no:

  - robots.txt is read once per host and obeyed, including Crawl-delay. Per
    RFC 9309, a robots.txt that is missing (4xx) allows everything and one the
    server fails to serve (5xx, or no answer) forbids everything until it can.
  - One request per host at a time, at least `min_delay` apart.
  - 429 and 5xx are retried with exponential backoff, and a Retry-After header
    wins over the backoff: the server knows its own load better than we do.
  - Answers are cached on disk by request, so re-running a crawl re-reads the
    cache instead of the site. That is the biggest saving of all: most of a
    re-crawl is pages that have not changed.
  - One User-Agent, the bot's own, with a URL and an address. No browser
    user agents and no rotation: dressing a bot as a browser is how a crawler
    gets around a block it was meant to respect.

Standard library only (urllib), so nothing new lands in the service image.
"""

from __future__ import annotations

import hashlib
import json
import random
import time
import urllib.error
import urllib.request
import urllib.robotparser
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable
from urllib.parse import urlsplit

from .config import (
    CRAWL_CACHE_TTL_SECONDS,
    CRAWL_MAX_RETRIES,
    CRAWL_MIN_DELAY_SECONDS,
    CRAWL_REQUEST_TIMEOUT_SECONDS,
    USER_AGENT,
)

RETRY_STATUSES = {429, 500, 502, 503, 504}


class Disallowed(Exception):
    """robots.txt forbids this URL for our user agent."""


class FetchFailed(Exception):
    def __init__(self, url: str, status: int | None, reason: str):
        super().__init__(f"{url}: {status or ''} {reason}".strip())
        self.url, self.status, self.reason = url, status, reason


@dataclass
class Response:
    url: str
    status: int
    body: bytes
    from_cache: bool = False
    headers: dict = field(default_factory=dict)

    def json(self):
        return json.loads(self.body.decode("utf-8"))


# (request) -> (status, headers, body). urllib by default; tests pass a fake.
Transport = Callable[[urllib.request.Request, float], tuple[int, dict, bytes]]


def urllib_transport(request: urllib.request.Request, timeout: float) -> tuple[int, dict, bytes]:
    try:
        with urllib.request.urlopen(request, timeout=timeout) as resp:  # noqa: S310 - http(s) only, checked below
            return resp.status, dict(resp.headers.items()), resp.read()
    except urllib.error.HTTPError as err:
        return err.code, dict(err.headers.items()) if err.headers else {}, err.read() or b""


class PoliteFetcher:
    def __init__(
        self,
        user_agent: str = USER_AGENT,
        min_delay: float = CRAWL_MIN_DELAY_SECONDS,
        timeout: float = CRAWL_REQUEST_TIMEOUT_SECONDS,
        max_retries: int = CRAWL_MAX_RETRIES,
        cache_dir: Path | None = None,
        cache_ttl: float = CRAWL_CACHE_TTL_SECONDS,
        transport: Transport = urllib_transport,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
        now: Callable[[], float] = time.time,
    ):
        self.user_agent = user_agent
        self.min_delay = min_delay
        self.timeout = timeout
        self.max_retries = max_retries
        self.cache_dir = cache_dir
        self.cache_ttl = cache_ttl
        self.transport = transport
        self.sleep = sleep
        self.clock = clock
        self.now = now
        self._robots: dict[str, urllib.robotparser.RobotFileParser | bool] = {}
        self._last_request: dict[str, float] = {}
        self.stats = {"requests": 0, "cache_hits": 0, "retries": 0, "disallowed": 0}

    # ── robots.txt ─────────────────────────────────────────────────────────

    def _robots_for(self, url: str):
        parts = urlsplit(url)
        host = f"{parts.scheme}://{parts.netloc}"
        if host not in self._robots:
            robots_url = f"{host}/robots.txt"
            status, _, body = self._send(urllib.request.Request(robots_url, headers={"User-Agent": self.user_agent}))
            if status is not None and 200 <= status < 300:
                parser = urllib.robotparser.RobotFileParser(robots_url)
                parser.parse(body.decode("utf-8", errors="replace").splitlines())
                self._robots[host] = parser
            elif status is not None and 400 <= status < 500:
                self._robots[host] = True  # no robots.txt: everything allowed
            else:
                self._robots[host] = False  # unreachable: nothing allowed
        return self._robots[host]

    def allowed(self, url: str) -> bool:
        robots = self._robots_for(url)
        if isinstance(robots, bool):
            return robots
        return robots.can_fetch(self.user_agent, url)

    def _delay_for(self, url: str) -> float:
        robots = self._robots.get(f"{urlsplit(url).scheme}://{urlsplit(url).netloc}")
        crawl_delay = None
        if robots is not None and not isinstance(robots, bool):
            crawl_delay = robots.crawl_delay(self.user_agent)
        return max(self.min_delay, float(crawl_delay or 0))

    # ── cache ──────────────────────────────────────────────────────────────

    def _cache_path(self, method: str, url: str, data: bytes | None) -> Path | None:
        if self.cache_dir is None:
            return None
        key = hashlib.sha256(method.encode() + b" " + url.encode() + b"\n" + (data or b"")).hexdigest()
        return self.cache_dir / f"{key}.json"

    def _cache_read(self, path: Path | None) -> Response | None:
        if path is None or not path.exists():
            return None
        entry = json.loads(path.read_text(encoding="utf-8"))
        if self.now() - entry["saved_at"] > self.cache_ttl:
            return None
        return Response(entry["url"], entry["status"], entry["body"].encode("latin-1"), from_cache=True)

    def _cache_write(self, path: Path | None, response: Response) -> None:
        if path is None:
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps({
                "url": response.url, "status": response.status, "saved_at": self.now(),
                "body": response.body.decode("latin-1"),
            }),
            encoding="utf-8",
        )

    # ── fetching ───────────────────────────────────────────────────────────

    def _send(self, request: urllib.request.Request) -> tuple[int | None, dict, bytes]:
        host = urlsplit(request.full_url).netloc
        wait = self._last_request.get(host, -1e9) + self._delay_for(request.full_url) - self.clock()
        if wait > 0:
            self.sleep(wait)
        self._last_request[host] = self.clock()
        self.stats["requests"] += 1
        try:
            return self.transport(request, self.timeout)
        except (urllib.error.URLError, TimeoutError, OSError):
            return None, {}, b""

    def fetch(self, url: str, data: bytes | None = None, headers: dict | None = None) -> Response:
        if urlsplit(url).scheme not in ("http", "https"):
            raise ValueError(f"not an http(s) URL: {url}")
        method = "POST" if data is not None else "GET"
        cache_path = self._cache_path(method, url, data)
        cached = self._cache_read(cache_path)
        if cached is not None:
            self.stats["cache_hits"] += 1
            return cached
        if not self.allowed(url):
            self.stats["disallowed"] += 1
            raise Disallowed(url)

        request = urllib.request.Request(
            url, data=data, method=method, headers={"User-Agent": self.user_agent, **(headers or {})}
        )
        status, reply_headers, body = None, {}, b""
        for attempt in range(self.max_retries + 1):
            status, reply_headers, body = self._send(request)
            if status is not None and status not in RETRY_STATUSES:
                break
            if attempt == self.max_retries:
                break
            self.stats["retries"] += 1
            retry_after = _retry_after_seconds(reply_headers)
            backoff = min(120.0, self.min_delay * (2**attempt)) + random.uniform(0, 0.5)
            self.sleep(retry_after if retry_after is not None else backoff)

        if status is None or not 200 <= status < 300:
            raise FetchFailed(url, status, "no answer" if status is None else "gave up")
        response = Response(url, status, body, headers=reply_headers)
        self._cache_write(cache_path, response)
        return response


def _retry_after_seconds(headers: dict) -> float | None:
    value = next((v for k, v in headers.items() if k.lower() == "retry-after"), None)
    if value is None:
        return None
    try:
        return max(0.0, min(600.0, float(value)))
    except ValueError:
        return None  # an HTTP-date; the backoff is a fine stand-in
