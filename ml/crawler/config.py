"""
Configuration and invariants for the Tacurong establishment and menu crawler.
"""

from __future__ import annotations

# ── Tacurong City Geographic Bounding Box ────────────────────────────────────
# Centered on Tacurong City, Sultan Kudarat, Philippines.
# Ensures that discovered coordinates stay within the operational territory.
TACURONG_BOUNDS = {
    "min_latitude": 6.6300,
    "max_latitude": 6.7600,
    "min_longitude": 124.6000,
    "max_longitude": 124.7500,
}

# ── Google Cloud Vision Quota Protection Limits ──────────────────────────────
# Protects the vision API quota so live rider receipts are never starved.
MAX_DAILY_CRAWLER_VISION_REQUESTS = 20
IMAGE_MIN_DIMENSION_PX = 400
IMAGE_MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024  # 5 MB

# ── Crawler Polite Request Throttling ────────────────────────────────────────
CRAWL_MIN_DELAY_SECONDS = 2.0
CRAWL_MAX_DELAY_SECONDS = 5.0
CRAWL_REQUEST_TIMEOUT_SECONDS = 15
CRAWL_MAX_RETRIES = 4
# A day. Shops open and close more slowly than that, and a re-run the same day
# should cost the source nothing.
CRAWL_CACHE_TTL_SECONDS = 24 * 3600

# One honest user agent. There used to be a desktop Chrome string beside it,
# rotated in: that is how a bot slips past a site that blocks bots, which is
# the opposite of polite. A site that refuses this agent is saying no.
USER_AGENT = "SUGOCityBot/1.0 (+https://sugo-express.org; bot@sugo-express.org)"
USER_AGENTS = [USER_AGENT]

# ── Sources ──────────────────────────────────────────────────────────────────
# A public Overpass API instance, for places mapped since the VPS's Philippines
# extract was downloaded. One Tacurong query is a few hundred objects.
#
# Not overpass-api.de: its robots.txt disallows /api/ for every user agent
# (checked 2026-09-24), and PoliteFetcher refused it, as it should. Kumi Systems
# runs a separate public instance, listed on the OpenStreetMap wiki, with no such
# rule. If that ever changes, the fetcher will refuse it too; the PBF snapshot
# (crawler.sources.osm_pbf) needs no API at all.
OVERPASS_URL = "https://overpass.kumi.systems/api/interpreter"
# An Overpass query may run server-side for up to its own [timeout:60], longer
# than the default 15 s request timeout. Two retries at most: these are
# volunteer-run servers, and on 2026-09-24 this one answered a 504 after 106 s.
OVERPASS_TIMEOUT_SECONDS = 90
OVERPASS_MAX_RETRIES = 2
