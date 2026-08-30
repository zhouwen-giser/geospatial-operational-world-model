import { describe, expect, it } from "vitest";

import { canonicalizeMigrationSql, selectMigrationFiles } from "../../scripts/migrate.js";

describe("migration selection", () => {
  const migrations = [
    "003_third.sql",
    "README.md",
    "001_first.sql",
    "004_fourth.sql",
    "002_second.sql"
  ];

  it("preserves the default behavior by selecting every numbered SQL migration in order", () => {
    expect(selectMigrationFiles(migrations)).toEqual([
      "001_first.sql",
      "002_second.sql",
      "003_third.sql",
      "004_fourth.sql"
    ]);
  });

  it("selects exactly migrations 001 through the requested maximum", () => {
    expect(selectMigrationFiles(migrations, 3)).toEqual([
      "001_first.sql",
      "002_second.sql",
      "003_third.sql"
    ]);
  });

  it.each([
    "01_too_short.sql",
    "000_zero.sql",
    "0001_too_long.sql",
    "001_.sql",
    "001_unsafe.name.sql"
  ])("rejects an invalid migration filename %s", (file) => {
    expect(() => selectMigrationFiles([file])).toThrow(/Invalid migration/u);
  });

  it("rejects duplicate and missing migration numbers", () => {
    expect(() => selectMigrationFiles(["001_first.sql", "001_duplicate.sql"]))
      .toThrow("Duplicate migration number 001");
    expect(() => selectMigrationFiles(["001_first.sql", "003_third.sql"], 3))
      .toThrow("Missing migration 002");
  });

  it.each([0, -1, 1.5, 1000, Number.NaN])("rejects an unsafe maximum %s", (maximum) => {
    expect(() => selectMigrationFiles(migrations, maximum))
      .toThrow("maximumMigrationNumber must be an integer between 1 and 999");
  });

  it("rejects a maximum beyond the available contiguous migrations", () => {
    expect(() => selectMigrationFiles(migrations, 5)).toThrow("Missing migration 005");
  });

  it("canonicalizes migration line endings before checksum comparison", () => {
    expect(canonicalizeMigrationSql("SELECT 1;\r\nSELECT 2;\rSELECT 3;\n"))
      .toBe("SELECT 1;\nSELECT 2;\nSELECT 3;\n");
  });
});
