// Exports the VerifiedPlace catalogue to GeoJSON so QGIS and the running system
// read the same ground truth. Load the output alongside the clipped OSM extract
// in QGIS to check that every POI actually sits on a routable road — a place
// pinned in the middle of a block is one the router will silently snap
// somewhere else, which shows up later as a wrong fare or a wrong ETA.
//
//   npx tsx scripts/exportPlacesGeoJson.ts [outputPath]
import { writeFileSync } from "node:fs";
import { prisma } from "../src/lib/prisma.js";

async function main() {
  const outputPath = process.argv[2] ?? "gis/verified-places.geojson";

  const places = await prisma.verifiedPlace.findMany({
    where: { isActive: true },
    include: { category: { select: { name: true } } },
    orderBy: [{ categoryId: "asc" }, { name: "asc" }],
  });

  const featureCollection = {
    type: "FeatureCollection",
    generatedAt: new Date().toISOString(),
    features: places.map((place) => ({
      type: "Feature",
      properties: {
        id: place.id,
        name: place.name,
        category: place.category.name,
        address: place.address,
        barangay: place.barangay,
      },
      // GeoJSON is [longitude, latitude] — the opposite of how these are stored.
      geometry: { type: "Point", coordinates: [place.longitude, place.latitude] },
    })),
  };

  writeFileSync(outputPath, JSON.stringify(featureCollection, null, 2), "utf-8");
  console.log(`Wrote ${places.length} active places to ${outputPath}`);
}

main()
  .catch((error) => {
    console.error("Export failed:", error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
