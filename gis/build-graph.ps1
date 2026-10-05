# Builds the OSRM routing graph for the SUGO operating region: Tacurong City
# and Banga (South Cotabato), plus the Tantangan roads that join them.
#
# Run once per OSM data refresh. Produces ./data/<OSRM_GRAPH>.osrm* which
# docker-compose.osrm.yml serves. Requires Docker. Windows twin of
# build-graph.sh; keep the defaults of the two identical.
#
# The same clipped extract is what you load in QGIS (see README.md) — the map
# the riders route on and the map in the paper are then provably the same data.

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$data = Join-Path $here "data"
New-Item -ItemType Directory -Force -Path $data | Out-Null

# GHCR, not Docker Hub. The OSRM project stopped publishing to docker.io at
# v5.25.0, so `osrm/osrm-backend:v5.27.1` does not resolve at all. Keep this in
# step with the image in docker-compose.osrm.yml — osrm-routed refuses to load a
# graph written by a different version.
$osrmImage = "ghcr.io/project-osrm/osrm-backend:v5.27.1"

# docker.exe returning non-zero sets $LASTEXITCODE but does NOT raise a
# terminating error, so $ErrorActionPreference above does not stop the script.
# Without this the run continued through every remaining pass after the first
# failure and still printed "Done." — reporting success on an empty data dir.
function Assert-LastExitCode {
    param([Parameter(Mandatory)][string]$Step)
    if ($LASTEXITCODE -ne 0) {
        throw "$Step failed (exit code $LASTEXITCODE). The graph was NOT built."
    }
}

# Bounding box (west,south,east,north). It must CONTAIN SERVICE_AREA_BOUNDS in
# src/constants/serviceArea.ts (web), or the app will let a dispatcher pin a
# store the router has no roads for. See build-graph.sh for how it was measured.
$graph = if ($env:OSRM_GRAPH) { $env:OSRM_GRAPH } else { "sugo-region" }
$bbox  = if ($env:OSRM_BBOX)  { $env:OSRM_BBOX }  else { "124.58,6.26,124.94,6.78" }

$pbfUrl  = "https://download.geofabrik.de/asia/philippines-latest.osm.pbf"
$pbfFull = Join-Path $data "philippines-latest.osm.pbf"
$pbfClip = Join-Path $data "$graph.osm.pbf"

if (-not (Test-Path $pbfFull)) {
    Write-Host "Downloading Philippines OSM extract (~600 MB, one time)..."
    Invoke-WebRequest -Uri $pbfUrl -OutFile $pbfFull
} else {
    Write-Host "Using cached $pbfFull"
}

Write-Host "Clipping $graph ($bbox)..."
docker run --rm -v "${data}:/data" stefda/osmium-tool `
    osmium extract --bbox $bbox --overwrite -o "/data/$graph.osm.pbf" /data/philippines-latest.osm.pbf
Assert-LastExitCode "osmium extract"

Write-Host "Extracting routing graph (car profile)..."
docker run --rm -v "${data}:/data" $osrmImage `
    osrm-extract -p /opt/car.lua "/data/$graph.osm.pbf"
Assert-LastExitCode "osrm-extract"

Write-Host "Partitioning (MLD)..."
docker run --rm -v "${data}:/data" $osrmImage osrm-partition "/data/$graph.osrm"
Assert-LastExitCode "osrm-partition"
docker run --rm -v "${data}:/data" $osrmImage osrm-customize "/data/$graph.osrm"
Assert-LastExitCode "osrm-customize"

Write-Host ""
Write-Host "Done: data/$graph.osrm. Serve it with OSRM_GRAPH=$graph in gis/.env, then:"
Write-Host "  docker compose -f docker-compose.osrm.yml up -d"
Write-Host "Then set OSRM_BASE_URL in server/.env and run: npx tsx gis/calibrate.ts"
