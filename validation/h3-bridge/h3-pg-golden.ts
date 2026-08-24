import {
  cellToChildren,
  cellToParent,
  gridDisk,
  latLngToCell,
  polygonToCells
} from "h3-js";
import pg from "pg";

const databaseUrl = process.argv[2] ?? process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("Pass TEST_DATABASE_URL as the first argument or environment variable");

const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const client = await pool.connect();
try {
  const extensions = await client.query<{ extname: string; extversion: string }>(
    "SELECT extname, extversion FROM pg_extension WHERE extname IN ('postgis','h3','h3_postgis') ORDER BY extname"
  );
  for (const required of ["postgis", "h3", "h3_postgis"]) {
    if (!extensions.rows.some((row) => row.extname === required)) throw new Error(`missing required extension ${required}`);
  }
  for (const extension of extensions.rows.filter((row) => row.extname.startsWith("h3"))) {
    if (!extension.extversion.startsWith("4.5")) throw new Error(`${extension.extname} is ${extension.extversion}, expected 4.5.x`);
  }

  await client.query("BEGIN READ ONLY");
  const pointCases = [
    { id: "tokyo-r9", longitude: 139.7671, latitude: 35.6812, resolution: 9, parentResolution: 5 },
    { id: "beijing-r9", longitude: 116.4, latitude: 39.9, resolution: 9, parentResolution: 7 },
    { id: "antimeridian-r5", longitude: 179.999, latitude: 0, resolution: 5, parentResolution: 2 }
  ];
  for (const item of pointCases) {
    const jsCell = latLngToCell(item.latitude, item.longitude, item.resolution);
    const pgCell = await client.query<{ cell: string }>(
      "SELECT h3_latlng_to_cell(ST_SetSRID(ST_MakePoint($1, $2), 4326), $3)::text AS cell",
      [item.longitude, item.latitude, item.resolution]
    );
    equal(pgCell.rows[0]?.cell, jsCell, `${item.id} point`);

    const jsParent = cellToParent(jsCell, item.parentResolution);
    const pgParent = await client.query<{ cell: string }>(
      "SELECT h3_cell_to_parent($1::h3index, $2)::text AS cell",
      [jsCell, item.parentResolution]
    );
    equal(pgParent.rows[0]?.cell, jsParent, `${item.id} parent`);

    const jsChildren = [...cellToChildren(jsParent, item.resolution)].sort();
    const pgChildren = await client.query<{ cell: string }>(
      "SELECT child::text AS cell FROM h3_cell_to_children($1::h3index, $2) AS child ORDER BY child",
      [jsParent, item.resolution]
    );
    equalJson(pgChildren.rows.map((row) => row.cell), jsChildren, `${item.id} children`);

    const jsDisk = [...gridDisk(jsCell, 1)].sort();
    const pgDisk = await client.query<{ cell: string }>(
      "SELECT cell::text AS cell FROM h3_grid_disk($1::h3index, 1) AS cell ORDER BY cell",
      [jsCell]
    );
    equalJson(pgDisk.rows.map((row) => row.cell), jsDisk, `${item.id} neighbors`);
  }

  const geometry = {
    type: "Polygon" as const,
    coordinates: [[[139.75, 35.675], [139.77, 35.675], [139.77, 35.69], [139.75, 35.69], [139.75, 35.675]]]
  };
  const jsCover = [...polygonToCells(geometry.coordinates, 9, true)].sort();
  const pgCover = await client.query<{ cell: string }>(
    "SELECT cell::text AS cell FROM h3_polygon_to_cells(ST_GeomFromGeoJSON($1), $2) AS cell ORDER BY cell",
    [JSON.stringify(geometry), 9]
  );
  equalJson(pgCover.rows.map((row) => row.cell), jsCover, "Tokyo center-containment polygon cover");
  await client.query("ROLLBACK");

  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    sourceEngine: "h3-js@4.5.0",
    databaseEngines: extensions.rows,
    pointCases: pointCases.length,
    hierarchyCases: pointCases.length,
    neighborhoodCases: pointCases.length,
    polygonCases: 1,
    coverSemantics: "CENTER_CONTAINMENT_COVER",
    exactSpatialVerification: "REQUIRED_SEPARATELY",
    writeTransaction: false
  })}\n`);
} catch (error) {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the primary failure; the harness never commits.
  }
  throw error;
} finally {
  client.release();
  await pool.end();
}

function equal(actual: string | undefined, expected: string, label: string): void {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, received ${actual ?? "missing"}`);
}

function equalJson(actual: string[], expected: string[], label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: h3-pg and h3-js sets differ`);
  }
}
