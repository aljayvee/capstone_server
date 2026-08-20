# GIS layer — OSM data, OSRM routing engine, QGIS workflow

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

Measured for Tacurong (10 POI pairs, 4 excluded as too short to be stable):
detour factor **1.48** (range 1.42–1.66), effective speed **25 km/h** (21–30).

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

- OSRM speaks `longitude,latitude`. So does GeoJSON. Everything else in this
  codebase uses `{ latitude, longitude }`. The flip is confined to
  `osrmProvider.ts` and the two GeoJSON loaders.
- OSRM reports some failures with an HTTP error status (`NoMatch` returns 400)
  and others with HTTP 200 (`NoRoute`). The adapter keys off the in-band `code`,
  never the HTTP status — see the comment in `osrmProvider.ts`.
- `/match` is capped by `--max-matching-size`. The adapter chunks long traces
  automatically (`OSRM_MAX_MATCH_POINTS`, default 90).
