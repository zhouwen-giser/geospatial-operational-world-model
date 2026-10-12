import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("GOWM v0.5 database image lock", () => {
  it("extends the pinned MobilityDB image with exact H3 and pgRouting sources", async () => {
    const dockerfile = await readFile(resolve(root, "database/Dockerfile"), "utf8");
    expect(dockerfile).toContain("mobilitydb/mobilitydb:18-3.6-1.3@sha256:8409e3897e2b88561bef4374110c3da5f7ff56838a7745315f1c2f111305dd24");
    expect(dockerfile).toContain("ARG H3_PG_VERSION=4.5.0");
    expect(dockerfile).toContain("ARG PGROUTING_VERSION=4.0.1");
    expect(dockerfile).toContain("ARG PGROUTING_SOURCE_SHA256=21c071983a682e048da28f0f211205a20f27ef3708c0b637b4e6e29994d7d699");
    expect(dockerfile).toContain("ADD --checksum=sha256:72f48359cd49ffaa38eb22fbaa607d5497e0144a8f94824f826beb0b370c40d8");
    expect(dockerfile).toContain("ADD --checksum=sha256:21c071983a682e048da28f0f211205a20f27ef3708c0b637b4e6e29994d7d699");
    expect(dockerfile).toContain("pgrouting/archive/v4.0.1.tar.gz");
    expect(dockerfile).not.toMatch(/^FROM\s+pgrouting\//mu);
  });

  it("health-gates all six required extensions and pins the composite image name", async () => {
    const compose = await readFile(resolve(root, "docker-compose.yml"), "utf8");
    expect(compose).toContain("gowm-plus-db:18-3.6-mobilitydb-1.3-h3-4.5.0-pgrouting-4.0.1");
    for (const extension of ["postgis", "mobilitydb", "h3", "h3_postgis", "pgrouting","vector"]) expect(compose).toContain(`'${extension}'`);
    expect(compose).toContain("grep -qx 6");
    expect(compose).toContain('-pgvector-0.8.6');
  });

  it("ships an SPDX SBOM, exact source checksums, and the full pgRouting license", async () => {
    const sbom = JSON.parse(await readFile(resolve(root, "database/sbom/gowm-db.spdx.json"), "utf8")) as {
      spdxVersion: string;
      packages: Array<{ name: string; versionInfo: string; licenseDeclared: string; checksums: Array<{ checksumValue: string }> }>;
    };
    expect(sbom.spdxVersion).toBe("SPDX-2.3");
    expect(sbom.packages).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "pgRouting", versionInfo: "4.0.1", licenseDeclared: "GPL-2.0-or-later" }),
      expect.objectContaining({ name: "h3-pg", versionInfo: "4.5.0", licenseDeclared: "Apache-2.0" })
      ,expect.objectContaining({name:'pgvector',versionInfo:'0.8.6',licenseDeclared:'PostgreSQL'})
    ]));
    expect(sbom.packages.flatMap(({ checksums }) => checksums.map(({ checksumValue }) => checksumValue))).toContain("21c071983a682e048da28f0f211205a20f27ef3708c0b637b4e6e29994d7d699");
    expect(await readFile(resolve(root, "database/licenses/pgRouting-GPL-2.0.txt"), "utf8")).toContain("GNU GENERAL PUBLIC LICENSE");
    expect(sbom.packages.flatMap(({checksums})=>checksums.map(({checksumValue})=>checksumValue))).toContain('10bf9938906e5d643bbc4a7eea104b6f57ba4898e5b76b20e60484ea1d5a7f8f');
    expect(await readFile(resolve(root,'database/licenses/pgvector-LICENSE.txt'),'utf8')).toContain('PostgreSQL');
  });

  it("contains the fraction=1 withPoints regression and exact extension assertions", async () => {
    const sql = await readFile(resolve(root, "database/tests/022_pgrouting_runtime_assertions.sql"), "utf8");
    expect(sql).toContain("CREATE EXTENSION IF NOT EXISTS pgrouting CASCADE");
    expect(sql).toContain("extension_versions ->> 'pgrouting' <> '4.0.1'");
    expect(sql).toContain("pgr_withPoints(");
    expect(sql).toContain("expected terminal cost 17");
    expect(sql).toContain("ARRAY[100, 101]::bigint[]");
  });
});
