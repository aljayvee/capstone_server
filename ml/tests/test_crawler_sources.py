"""
The crawler's fetching, sources and deduplication, without the network.

A fake transport stands in for the internet so the politeness rules can be
checked exactly: what was asked for, how often, and what was not asked for.
"""

from __future__ import annotations

import json
import urllib.parse

import pytest

from crawler import config
from crawler.dedupe import dedupe, metres_between
from crawler.fetcher import Disallowed, FetchFailed, PoliteFetcher
from crawler.sources.overpass import build_query, parse
from sugo_category.lexicon import FOOD, GROCERY, PHARMACY
from sugo_category.osm_labels import label_for_tags, resolve_label


class FakeNet:
    """Answers by URL from a script; records every request and every sleep."""

    def __init__(self, routes: dict[str, list[tuple[int, dict, bytes]]]):
        self.routes = {url: list(answers) for url, answers in routes.items()}
        self.requests: list = []
        self.slept: list[float] = []
        self.t = 0.0

    def transport(self, request, timeout):
        self.requests.append(request)
        answers = self.routes.get(request.full_url)
        if not answers:
            return 404, {}, b""
        return answers.pop(0) if len(answers) > 1 else answers[0]

    def sleep(self, seconds: float):
        self.slept.append(seconds)
        self.t += seconds

    def fetcher(self, **kwargs) -> PoliteFetcher:
        return PoliteFetcher(transport=self.transport, sleep=self.sleep, clock=lambda: self.t, **kwargs)


ROBOTS = "https://example.test/robots.txt"
PAGE = "https://example.test/menu"


def test_the_only_user_agent_is_the_bots_own():
    assert config.USER_AGENTS == [config.USER_AGENT]
    assert "SUGOCityBot" in config.USER_AGENT
    assert not any("Mozilla" in ua for ua in config.USER_AGENTS)
    net = FakeNet({ROBOTS: [(404, {}, b"")], PAGE: [(200, {}, b"ok")]})
    net.fetcher().fetch(PAGE)
    assert {r.get_header("User-agent") for r in net.requests} == {config.USER_AGENT}


def test_robots_txt_disallow_is_obeyed():
    net = FakeNet({ROBOTS: [(200, {}, b"User-agent: *\nDisallow: /menu\n")], PAGE: [(200, {}, b"ok")]})
    with pytest.raises(Disallowed):
        net.fetcher().fetch(PAGE)
    assert [r.full_url for r in net.requests] == [ROBOTS]


def test_unreachable_robots_txt_means_nothing_is_fetched():
    net = FakeNet({ROBOTS: [(503, {}, b"")], PAGE: [(200, {}, b"ok")]})
    with pytest.raises(Disallowed):
        net.fetcher().fetch(PAGE)


def test_missing_robots_txt_allows_the_page():
    net = FakeNet({ROBOTS: [(404, {}, b"")], PAGE: [(200, {}, b"ok")]})
    assert net.fetcher().fetch(PAGE).body == b"ok"


def test_crawl_delay_spaces_requests_to_one_host():
    net = FakeNet({
        ROBOTS: [(200, {}, b"User-agent: *\nCrawl-delay: 7\n")],
        PAGE: [(200, {}, b"a")],
        PAGE + "2": [(200, {}, b"b")],
    })
    f = net.fetcher(min_delay=1.0)
    f.fetch(PAGE)
    f.fetch(PAGE + "2")
    assert net.slept and max(net.slept) == pytest.approx(7.0)


def test_retry_after_is_honoured_then_the_answer_arrives():
    net = FakeNet({
        ROBOTS: [(404, {}, b"")],
        PAGE: [(429, {"Retry-After": "30"}, b""), (503, {}, b""), (200, {}, b"ok")],
    })
    f = net.fetcher(min_delay=1.0)
    assert f.fetch(PAGE).body == b"ok"
    assert 30.0 in net.slept
    assert f.stats["retries"] == 2


def test_gives_up_after_the_retry_budget():
    net = FakeNet({ROBOTS: [(404, {}, b"")], PAGE: [(503, {}, b"")]})
    with pytest.raises(FetchFailed):
        net.fetcher(max_retries=2).fetch(PAGE)
    assert sum(r.full_url == PAGE for r in net.requests) == 3


def test_a_cached_answer_costs_the_site_nothing(tmp_path):
    net = FakeNet({ROBOTS: [(404, {}, b"")], PAGE: [(200, {}, b"menu v1")]})
    first = net.fetcher(cache_dir=tmp_path).fetch(PAGE)
    asked = len(net.requests)
    again = net.fetcher(cache_dir=tmp_path).fetch(PAGE)
    assert (first.from_cache, again.from_cache) == (False, True)
    assert again.body == b"menu v1"
    assert len(net.requests) == asked


def test_only_http_urls():
    with pytest.raises(ValueError):
        FakeNet({}).fetcher().fetch("file:///etc/passwd")


# ── OpenStreetMap ──────────────────────────────────────────────────────────


def test_overpass_query_covers_the_box_and_the_kinds():
    q = build_query({"min_latitude": 6.63, "min_longitude": 124.6, "max_latitude": 6.76, "max_longitude": 124.75})
    assert "(6.63,124.6,6.76,124.75)" in q
    assert '"shop"' in q and '"healthcare"' in q and "fast_food" in q and "out center tags" in q


def test_overpass_answer_becomes_extract_rows():
    payload = {
        "elements": [
            {"type": "node", "id": 1, "lat": 6.69, "lon": 124.67, "tags": {"name": "Rojon  Pharmacy", "amenity": "pharmacy"}},
            {"type": "way", "id": 2, "center": {"lat": 6.7, "lon": 124.68}, "tags": {"name": "NCCC", "shop": "supermarket"}},
            {"type": "node", "id": 3, "lat": 6.7, "lon": 124.6, "tags": {"shop": "convenience"}},  # unnamed
        ]
    }
    rows = parse(payload)
    assert [r["name"] for r in rows] == ["Rojon Pharmacy", "NCCC"]
    assert rows[1]["lat"] == "6.700000" and rows[1]["shop"] == "supermarket"


def test_fetch_places_posts_one_query_through_the_fetcher():
    from crawler.sources.overpass import fetch_places

    api = "https://overpass.test/api/interpreter"
    body = json.dumps({"elements": [{"type": "node", "id": 9, "lat": 6.7, "lon": 124.7, "tags": {"name": "Kimsan Plaza", "shop": "department_store"}}]}).encode()
    net = FakeNet({"https://overpass.test/robots.txt": [(404, {}, b"")], api: [(200, {}, body)]})
    rows = fetch_places(net.fetcher(), url=api)
    assert rows[0]["name"] == "Kimsan Plaza"
    sent = urllib.parse.parse_qs(net.requests[-1].data.decode())
    assert "out center tags" in sent["data"][0]


@pytest.mark.parametrize(
    "tags,expected",
    [
        ({"amenity": "fast_food"}, FOOD),
        ({"amenity": "pharmacy"}, PHARMACY),
        ({"healthcare": "dentist"}, PHARMACY),
        ({"shop": "supermarket"}, GROCERY),
        ({"shop": "general"}, None),  # sari-sari or general merchandise: not guessed
        ({"shop": "hairdresser"}, None),  # a service, nothing to buy
        ({"amenity": "cafe", "shop": "bakery"}, None),  # two answers: left out
        ({"amenity": "restaurant", "cuisine": "pizza"}, FOOD),
    ],
)
def test_osm_tags_to_labels(tags, expected):
    assert label_for_tags(tags) == expected


def test_concepts_follow_the_catalogue():
    four = None
    six = [FOOD, PHARMACY, GROCERY, "Retail & General Merchandise", "Bakery", "Convenience Store"]
    assert resolve_label("bakery", four) == FOOD
    assert resolve_label("bakery", six) == "Bakery"
    assert resolve_label("convenience", four) == GROCERY
    assert resolve_label("convenience", six) == "Convenience Store"
    assert resolve_label(PHARMACY, [FOOD]) is None


# ── deduplication ──────────────────────────────────────────────────────────


def _place(osm_id, name, lat, lon, **tags):
    return {"osm_type": "node", "osm_id": osm_id, "name": name, "lat": str(lat), "lon": str(lon), **tags}


def test_same_osm_object_keeps_the_later_source():
    old = _place(1, "Rojon Pharmacy", 6.69, 124.67)
    new = _place(1, "Rojon Pharmacy Tacurong", 6.69, 124.67, amenity="pharmacy")
    assert [r["name"] for r in dedupe([old], [new])] == ["Rojon Pharmacy Tacurong"]


def test_the_same_shop_mapped_twice_nearby_is_one_shop():
    point = _place(1, "Julie's Bakeshop", 6.6900, 124.6700)
    building = {**_place(2, "Julies Bakeshop", 6.6902, 124.6701, shop="bakery"), "osm_type": "way"}
    far = _place(3, "Julie's Bakeshop", 6.7100, 124.6700)  # another branch, ~2 km away
    kept = dedupe([point, building, far])
    assert len(kept) == 2
    assert any(r.get("shop") == "bakery" for r in kept)  # the richer duplicate won


def test_metres_between():
    assert metres_between(6.69, 124.67, 6.69, 124.67) == 0
    assert metres_between(6.69, 124.67, 6.70, 124.67) == pytest.approx(1112, rel=0.01)
