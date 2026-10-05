#!/usr/bin/env bash
# Builds the OSRM routing graph for the SUGO operating region: Tacurong City
# (Sultan Kudarat) and Banga (South Cotabato), plus the Tantangan and Koronadal
# roads that join them.
#
# Linux/macOS counterpart of build-graph.ps1 — this is the one to run on the
# VPS. Produces ./data/${OSRM_GRAPH}.osrm* which docker-compose.osrm.yml serves.
#
# Both knobs are overridable; the defaults below are the production region:
#   OSRM_GRAPH=sugo-region OSRM_BBOX=124.58,6.26,124.94,6.78 ./build-graph.sh
# Build under a NEW name when changing the area, then point the compose file at
# it (OSRM_GRAPH in gis/.env). The running engine keeps serving the old graph
# until that switch, so a failed build never takes routing down.
#
# Requires: docker, and either osmium-tool (apt install osmium-tool) or docker
# to run it. Peak RAM is small because the extract is clipped to the city
# BEFORE osrm-extract runs; processing the whole Philippines file directly would
# need several GB.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
data="$here/data"
mkdir -p "$data"

# Bounding box (west,south,east,north). It must CONTAIN the service area
# (gis/tacurong-service-area.geojson, src/lib/serviceArea.ts) and the Places
# search bounds in the dispatcher console, or the app will let a dispatcher pin a
# store the router has no roads for. It may be larger: a wider graph costs a few
# MB and nothing else.
#
# Measured 2026-09-23 from the OSM administrative boundaries (Nominatim):
#   Tacurong  S 6.568  N 6.760  W 124.619  E 124.728
#   Banga     S 6.283  N 6.514  W 124.707  E 124.919
# They do not touch. The road between them runs through Tantangan
# (S 6.490 N 6.663), so one box spans all three, with ~2 km of margin so a route
# near an edge is not forced onto a detour by a clipped junction.
graph="${OSRM_GRAPH:-sugo-region}"
bbox="${OSRM_BBOX:-124.58,6.26,124.94,6.78}"

# GHCR, not Docker Hub. The OSRM project stopped publishing to docker.io at
# v5.25.0, so `osrm/osrm-backend:v5.27.1` does not resolve at all. Keep this in
# step with the image in docker-compose.osrm.yml — osrm-routed refuses to load a
# graph written by a different version.
osrm_image="ghcr.io/project-osrm/osrm-backend:v5.27.1"

# The routing profile. profiles/sugo-rider.lua is the car profile capped at
# 60 km/h, so routes are chosen at the speed a rider actually rides. Set
# OSRM_PROFILE=/opt/car.lua to build with the stock car profile instead.
profile="${OSRM_PROFILE:-/profiles/sugo-rider.lua}"

pbf_url="https://download.geofabrik.de/asia/philippines-latest.osm.pbf"
pbf_full="$data/philippines-latest.osm.pbf"
pbf_clip="$data/$graph.osm.pbf"

if [[ ! -f "$pbf_full" ]]; then
  echo "Downloading Philippines OSM extract (~600 MB, one time)..."
  # Written to a temporary name first: an interrupted download left behind
  # under the real name would be taken as the cache on every later run.
  curl -L --fail -o "$pbf_full.part" "$pbf_url"
  mv "$pbf_full.part" "$pbf_full"
else
  echo "Using cached $pbf_full"
fi

echo "Clipping $graph ($bbox)..."
if command -v osmium >/dev/null 2>&1; then
  osmium extract --bbox "$bbox" --overwrite -o "$pbf_clip" "$pbf_full"
else
  docker run --rm -v "$data:/data" stefda/osmium-tool \
    osmium extract --bbox "$bbox" --overwrite -o "/data/$graph.osm.pbf" /data/philippines-latest.osm.pbf
fi
echo "Clipped size: $(du -h "$pbf_clip" | cut -f1)"

echo "Extracting routing graph ($profile)..."
docker run --rm -v "$data:/data" -v "$here/profiles:/profiles:ro" "$osrm_image" \
  osrm-extract -p "$profile" "/data/$graph.osm.pbf"

echo "Partitioning (MLD)..."
docker run --rm -v "$data:/data" "$osrm_image" osrm-partition "/data/$graph.osrm"
docker run --rm -v "$data:/data" "$osrm_image" osrm-customize "/data/$graph.osrm"

cat <<DONE

Done: $data/$graph.osrm

Serve it. OSRM_GRAPH picks the graph, and gis/.env keeps the choice across restarts:
  echo "OSRM_GRAPH=$graph" > "$here/.env"
  docker compose -f docker-compose.osrm.yml up -d

Verify (inside Tacurong, then Tacurong to Banga):
  curl "http://localhost:5001/route/v1/driving/124.6752,6.6873;124.6635,6.6702?overview=false"
  curl "http://localhost:5001/route/v1/driving/124.6752,6.6873;124.7789,6.4236?overview=false"

Then set OSRM_BASE_URL in server/.env and run:
  npx tsx gis/calibrate.ts
DONE
