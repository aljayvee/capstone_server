#!/usr/bin/env bash
# One-time (and after every extract rebuild) load of the OSM extract into the
# tile server's database. See docker-compose.tiles.yml.
#
# Usage: ./import-tiles.sh            (uses data/${OSRM_GRAPH:-sugo-region}.osm.pbf)
#
# Re-importing drops and recreates the database volume. Rendered tiles from the
# old data are cleared with it, or they would keep showing the old roads.
set -euo pipefail

cd "$(dirname "$0")"
[ -f .env ] && set -a && . ./.env && set +a

GRAPH="${OSRM_GRAPH:-sugo-region}"
PBF="$PWD/data/${GRAPH}.osm.pbf"
IMAGE="overv/openstreetmap-tile-server:2.3.0"

if [ ! -f "$PBF" ]; then
  echo "Missing $PBF. Run build-graph.sh first; it cuts the extract." >&2
  exit 1
fi

echo "Stopping the tile server if it is running..."
docker compose -f docker-compose.tiles.yml down || true

echo "Clearing the old database and tile cache..."
docker volume rm sugo-osm-db sugo-osm-tiles 2>/dev/null || true
docker volume create sugo-osm-db >/dev/null
docker volume create sugo-osm-tiles >/dev/null

echo "Importing $PBF (downloads the style's coastline data on first run)..."
docker run --rm \
  -v "$PBF:/data/region.osm.pbf:ro" \
  -v sugo-osm-db:/data/database/ \
  -e THREADS=3 \
  "$IMAGE" import

echo "Starting the tile server..."
docker compose -f docker-compose.tiles.yml up -d
echo "Done. Probe: curl -sI http://127.0.0.1:8080/tile/12/3466/1971.png"
