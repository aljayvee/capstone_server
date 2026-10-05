# GIS layer — OSM data, OSRM routing engine, QGIS workflow

> ### Rider profile and map tiles, live since 2026-09-24
>
> **Routing profile.** `capstone-osrm` now serves `sugo-rider`: the same region
> and extract as `sugo-region`, built with `profiles/sugo-rider.lua`, which is
> the stock car profile with no road faster than 60 km/h. The car profile's
> 85 km/h on trunk roads decided which road OSRM chose, not just the time it
> quoted: Banga to Tacurong went 52.9 km up the Isulan–Surallah Road instead of
> 44.8 km on the Maharlika Highway. It now takes the Maharlika route (54 min),
> as Google does (45.1 km, 55 min). In-town routes are unchanged. Roll back
> with `OSRM_GRAPH=sugo-region` in `gis/.env` and `up -d`; that graph is still
> on disk. `build-graph.sh` uses this profile by default (`OSRM_PROFILE`
> overrides it).
>
> **Map tiles.** `capstone-tiles` (`docker-compose.tiles.yml`,
> `overv/openstreetmap-tile-server:2.3.0`) renders OpenStreetMap tiles from the
> same extract, for Sugo Rider's "OpenStreetMap" map option. On it, the route
> line sits exactly on the drawn road, because both come from one dataset. Load
> or reload the data with `./import-tiles.sh` after every extract rebuild.
> Loopback only (`127.0.0.1:8080`); nginx serves it publicly as
> `https://api.sugo-express.org/tiles/{z}/{x}/{y}.png` (zoom 0 to 20),
> 30 req/s per IP with a burst of 120, cached for 30 days in
> `/var/cache/nginx/sugo-tiles` (config: `/etc/nginx/conf.d/sugo_tiles.conf`
> and a `location` in the api site). `/root/warm-tiles.sh` pre-renders zooms
> 10 to 16 over the region. Self-hosted because `tile.openstreetmap.org`'s
> usage policy forbids apps from relying on it.
>
> **Google fallback.** Production `.env` had the key as `Google_MAPS_API_KEY`,
> which the server never read (`GOOGLE_MAPS_API_KEY`), so the chain was
> effectively osrm → haversine. Renamed on 2026-09-24; `configuredProviderNames()`
> now reports `osrm,google,haversine`.

> ### Region graph: Tacurong + Banga, live since 2026-09-23
>
> `capstone-osrm` now serves `sugo-region`, bbox `124.58,6.26,124.94,6.78`:
> Tacurong City, Banga (South Cotabato), and the Tantangan / Koronadal roads
> between them. Built on the VPS by `build-graph.sh` in about two minutes (29 MB
> on disk, 25 MB peak RAM). Tacurong to Banga town proper routes at 42.8 km /
> 51 min via the Koronadal–Tacurong National Highway and Maharlika Highway;
> before this it returned `NoRoute` and fell through to Google's generalised
> polyline, which is why those route lines did not sit on the road.
>
> `OSRM_GRAPH` in `gis/.env` selects the served graph. The old city-only
> `tacurong` graph is still on disk: `echo OSRM_GRAPH=tacurong > .env` and
> `docker compose -f docker-compose.osrm.yml up -d` rolls back.
>
> The **service area was not widened**. `tacurong-service-area.geojson` and the
> web `SERVICE_AREA_BOUNDS` (`src/constants/serviceArea.ts`) still describe Tacurong only, so Banga addresses route
> correctly but are not yet orderable. Widening them is a business decision; the
> graph already covers it. The section below describes the original city graph.

> ### Status: live since 2026-08-22
>
> Container `capstone-osrm` serves the Tacurong graph on `127.0.0.1:5001`, and
> `OSRM_BASE_URL` is set in `server/.env`. The provider chain is
> **osrm → google → haversine**, confirmed via `configuredProviderNames()`.
>
> The graph is small: 8,724 edges / 15,516 nodes, ~3 MB on disk, peak build RAM
> under 20 MB. `osrm-extract` takes seconds — the only slow part is the one-time
> 600 MB country download, which is cached.

Everything the system knows about roads comes from one OpenStreetMap extract of
Tacurong City. The same file feeds three things, which is the point: the routing
engine the riders use, the fare the customer is quoted, and the maps in the
paper are all provably the same data.

```
Geofabrik philippines-latest.osm.pbf
        │  osmium extract --bbox 124.60,6.62,124.73,6.74
        ▼
   tacurong.osm.pbf ──────────────┬──────────────────────────┐
        │ osrm-extract/partition  │ load as vector layer     │
        │        /customize       │                          │
        ▼                         ▼                          ▼
   tacurong.osrm            QGIS road layer          service-area polygon
        │                         │                          │
   osrm-routed              verified-places.geojson    tacurong-service-area.geojson
        │                   (scripts/exportPlacesGeoJson.ts)  │
        ▼                                                    ▼
   OSRM_BASE_URL  ◄── server/src/lib/routing/       src/lib/serviceArea.ts
```

## 1. Build the routing graph

On the VPS (Linux):

```bash
./build-graph.sh
```

On a Windows workstation:

```powershell
./build-graph.ps1
```

Downloads the Philippines extract (~600 MB, cached after the first run), clips
it to the service-area bounding box, then runs the three OSRM preprocessing
passes. Requires Docker.

Clipping happens **before** `osrm-extract`, which is what keeps this cheap: the
city-sized graph needs well under 1 GB RAM, where processing the full Philippines
file directly would need several GB. A 2 GB / 1 vCPU VPS is sufficient.

## 2. Start the engine

```bash
docker compose -f docker-compose.osrm.yml up -d
```

> **`osrm-routed` has no authentication and no rate limiting.** Anyone who can
> reach the port can use your routing server. The compose file therefore binds
> to `127.0.0.1` by default. When the API server lives on a different host, set
> `OSRM_BIND` to a private/VPN interface and firewall the port to the API
> server's address — never bind it to `0.0.0.0`.

```bash
# On the OSRM host, exposing only to the private network:
OSRM_BIND=10.0.0.5 docker compose -f docker-compose.osrm.yml up -d
```

Then set `OSRM_BASE_URL` in `server/.env` (e.g. `http://10.0.0.5:5001`).

Sanity check — should return `"code":"Ok"`:

```bash
curl "$OSRM_BASE_URL/route/v1/driving/124.6752,6.6873;124.6635,6.6702?overview=false"
```

Nothing breaks while OSRM is down or unset: the server falls through to Google
Directions and then to the calibrated straight-line estimate, flagging the
result `degraded` so ETA ranges widen instead of lying. See
`src/lib/routing/resilientRoutingService.ts`.

## 3. Calibrate the offline fallback

```bash
npx tsx gis/calibrate.ts
```

When the routing engine is unreachable the server falls back to straight-line
distance scaled by `ROAD_DETOUR_FACTOR`, at `FALLBACK_AVG_SPEED_KMH`. Those two
constants feed **fare calculation**, so they are measured against the real road
network rather than guessed. Re-run after any OSM data refresh.

Measured 2026-08-22 against the live graph (7 pairs sampled, 3 excluded as too
short to be stable): detour factor **1.43** (range 1.24–1.66), effective speed
**29 km/h** (24.8–30.1).

The POI list had given "STI College Tacurong" Mercury Drug Tacurong Center's
exact coordinate, which put two supposedly cross-town points 133 m apart and got
that pair excluded as unstable. Correcting it recovered a real long pair, so
these figures rest on 7 samples rather than 6.

**Only the detour factor was adopted.** `ROAD_DETOUR_FACTOR` is now 1.43 — it
describes the street grid, not the vehicle, so the measurement is simply better
than the earlier 1.48. `FALLBACK_AVG_SPEED_KMH` stays at **25**, against the
measured 29, because that is what `car.lua` predicts for a *car* in free flow and
the riders are on motorcycles in traffic. 25 also biases the estimate toward a
longer ETA, which is the right direction to be wrong in. Re-running calibration
will keep reporting high twenties; that is expected, not a discrepancy to fix.

Short pairs are excluded deliberately — two POIs 133 m apart measured 1.8 km by
road around a one-way loop, a ratio of 13.6. Real, but meaningless for the
distances that actually get billed.

## 4. QGIS workflow (for the paper)

1. Layer → Add Vector Layer → `data/tacurong.osm.pbf`, take the `lines` layer;
   filter to `highway IS NOT NULL` for the routable network.
2. Add `tacurong-service-area.geojson` — the operating boundary. The committed
   version is still the bounding-box envelope; **digitise the real city boundary
   over it and save in place**. `src/lib/serviceArea.ts` reads an arbitrary
   polygon, so nothing in the code changes when you do.
3. Generate and add the POI layer:
   ```bash
   npx tsx scripts/exportPlacesGeoJson.ts
   ```
4. Validate: every POI should sit on or beside a road in the `highway` layer. A
   place pinned mid-block gets silently snapped elsewhere by the router, which
   surfaces later as a wrong fare or a wrong ETA — this is the check that
   catches it before a customer does.

## Notes

- **The images come from GHCR, not Docker Hub.** The OSRM project stopped
  publishing to `docker.io/osrm/osrm-backend` at v5.25.0 — its `latest` there
  dates from July 2021 — so the pinned `v5.27.1` resolves only at
  `ghcr.io/project-osrm/osrm-backend`. Pulling the Docker Hub path fails with a
  bare `not found`. The tag appears in three places (`build-graph.ps1`,
  `build-graph.sh`, `docker-compose.osrm.yml`) and they must agree: `osrm-routed`
  refuses to load a graph written by a different version.
- **The profile is `car.lua`, but the riders are on motorcycles.** This is a
  deliberate choice, not an oversight. The alternatives are worse: `bicycle.lua`
  and `foot.lua` route over footpaths and pedestrian-only segments a rider cannot
  legally or safely take, which would produce directions nobody can follow. The
  car profile's one-way and turn restrictions are the ones a motorcycle is also
  bound by; where a tricycle in Tacurong takes a liberty a car cannot, the router
  will simply propose the legal way round. The speed model is corrected out of
  band by the calibrated `FALLBACK_AVG_SPEED_KMH` (25 km/h), not by the profile.
  Revisit only with measured evidence that the routes, rather than the times, are
  wrong.
- OSRM speaks `longitude,latitude`. So does GeoJSON. Everything else in this
  codebase uses `{ latitude, longitude }`. The flip is confined to
  `osrmProvider.ts` and the two GeoJSON loaders.
- OSRM reports some failures with an HTTP error status (`NoMatch` returns 400)
  and others with HTTP 200 (`NoRoute`). The adapter keys off the in-band `code`,
  never the HTTP status — see the comment in `osrmProvider.ts`.
- `/match` is capped by `--max-matching-size`. The adapter chunks long traces
  automatically (`OSRM_MAX_MATCH_POINTS`, default 90).
