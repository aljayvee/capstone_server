#!/usr/bin/env bash
# Builds the OSRM routing graph for the Tacurong City service area.
#
# Linux/macOS counterpart of build-graph.ps1 — this is the one to run on the
# VPS. Produces ./data/tacurong.osrm* which docker-compose.osrm.yml serves.
#
# Requires: docker, and either osmium-tool (apt install osmium-tool) or docker
# to run it. Peak RAM is small because the extract is clipped to the city
# BEFORE osrm-extract runs; processing the whole Philippines file directly would
# need several GB.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
data="$here/data"
mkdir -p "$data"

# Bounding box for the service area. Keep identical to the Places search bounds
# used in the dispatcher console and to gis/tacurong-service-area.geojson — if
# you widen one, widen the others, or the app will let a dispatcher pin a store
# the router has no roads for.
bbox="124.60,6.62,124.73,6.74"

pbf_url="https://download.geofabrik.de/asia/philippines-latest.osm.pbf"
pbf_full="$data/philippines-latest.osm.pbf"
pbf_clip="$data/tacurong.osm.pbf"

if [[ ! -f "$pbf_full" ]]; then
  echo "Downloading Philippines OSM extract (~600 MB, one time)..."
  curl -L --fail -o "$pbf_full" "$pbf_url"
else
  echo "Using cached $pbf_full"
fi

echo "Clipping to Tacurong service area ($bbox)..."
if command -v osmium >/dev/null 2>&1; then
  osmium extract --bbox "$bbox" --overwrite -o "$pbf_clip" "$pbf_full"
else
  docker run --rm -v "$data:/data" stefda/osmium-tool \
    osmium extract --bbox "$bbox" --overwrite -o /data/tacurong.osm.pbf /data/philippines-latest.osm.pbf
fi
echo "Clipped size: $(du -h "$pbf_clip" | cut -f1)"

echo "Extracting routing graph (car profile)..."
docker run --rm -v "$data:/data" osrm/osrm-backend:v5.27.1 \
  osrm-extract -p /opt/car.lua /data/tacurong.osm.pbf

echo "Partitioning (MLD)..."
docker run --rm -v "$data:/data" osrm/osrm-backend:v5.27.1 osrm-partition /data/tacurong.osrm
docker run --rm -v "$data:/data" osrm/osrm-backend:v5.27.1 osrm-customize /data/tacurong.osrm

cat <<'DONE'

Done. Start the engine with:
  docker compose -f docker-compose.osrm.yml up -d

Verify:
  curl "http://localhost:5001/route/v1/driving/124.6752,6.6873;124.6635,6.6702?overview=false"

Then set OSRM_BASE_URL in server/.env and run:
  npx tsx gis/calibrate.ts
DONE
