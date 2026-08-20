# Builds the OSRM routing graph for the Tacurong City service area.
#
# Run once per OSM data refresh. Produces ./data/tacurong.osrm* which
# docker-compose.osrm.yml serves. Requires Docker.
#
# The same clipped extract is what you load in QGIS (see README.md) — the map
# the riders route on and the map in the paper are then provably the same data.

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$data = Join-Path $here "data"
New-Item -ItemType Directory -Force -Path $data | Out-Null

# Bounding box for the service area. Kept identical to SERVICE_AREA_BBOX in
# src/constants/serviceArea.ts (web) — if you widen one, widen both, or the app
# will let a dispatcher pin a store the router has no roads for.
$bbox = "124.60,6.62,124.73,6.74"

$pbfUrl  = "https://download.geofabrik.de/asia/philippines-latest.osm.pbf"
$pbfFull = Join-Path $data "philippines-latest.osm.pbf"
$pbfClip = Join-Path $data "tacurong.osm.pbf"

if (-not (Test-Path $pbfFull)) {
    Write-Host "Downloading Philippines OSM extract (~600 MB, one time)..."
    Invoke-WebRequest -Uri $pbfUrl -OutFile $pbfFull
} else {
    Write-Host "Using cached $pbfFull"
}

Write-Host "Clipping to Tacurong service area ($bbox)..."
docker run --rm -v "${data}:/data" stefda/osmium-tool `
    osmium extract --bbox $bbox --overwrite -o /data/tacurong.osm.pbf /data/philippines-latest.osm.pbf

Write-Host "Extracting routing graph (car profile)..."
docker run --rm -v "${data}:/data" osrm/osrm-backend:v5.27.1 `
    osrm-extract -p /opt/car.lua /data/tacurong.osm.pbf

Write-Host "Partitioning (MLD)..."
docker run --rm -v "${data}:/data" osrm/osrm-backend:v5.27.1 osrm-partition /data/tacurong.osrm
docker run --rm -v "${data}:/data" osrm/osrm-backend:v5.27.1 osrm-customize /data/tacurong.osrm

Write-Host ""
Write-Host "Done. Start the engine with:"
Write-Host "  docker compose -f docker-compose.osrm.yml up -d"
Write-Host "Then set OSRM_BASE_URL in server/.env and run: npx tsx gis/calibrate.ts"
