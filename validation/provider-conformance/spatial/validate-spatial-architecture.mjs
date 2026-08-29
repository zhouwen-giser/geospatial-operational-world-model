import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const serviceRoot = join(root, "services", "providers", "spatial-provider-bridge");
const sqlPath = join(serviceRoot, "src", "sql.ts");
const repositoryPath = join(serviceRoot, "src", "repository.ts");
const migrationPath = join(root, "database", "migrations", "012_gowm_spatial_v1_read_contract.sql");
const catalogFeatureMigrationRelativePath = "database/migrations/062_reference_geometry_composability.sql";
const catalogFeatureMigrationPath = join(root, ...catalogFeatureMigrationRelativePath.split("/"));
const sourceLockPath = join(root, "contracts", "manifests", "providers", "spatial-provider-source-lock.json");
const findings = [];

const sourceFiles = walk(serviceRoot).filter((path) => [".ts", ".js", ".mjs"].includes(extname(path)));
for (const path of sourceFiles) {
  const source = readFileSync(path, "utf8");
  reject(path, source, /(?:fetch\s*\(|axios|undici|services[\\/]providers[\\/](?!spatial-provider-bridge))/iu,
    "provider-to-provider or arbitrary network client detected");
  reject(path, source, /(?:child_process|execFile|spawn\s*\()/u, "process escape detected");
}

const sql = readFileSync(sqlPath, "utf8");
reject(sqlPath, sql, /\$\{\s*(?:input|rawInput)\s*[.[]/u, "caller value interpolated directly into SQL");
reject(sqlPath, sql, /\b(?:FROM|JOIN)\s+(?:public\.)?(?:world_object|world_object_state|world_object_geometry|spatial_object|spatial_object_version|world_reference_identity)\b/iu,
  "Foundation base table referenced");
for (const match of sql.matchAll(/\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)\./giu)) {
  if (match[1] !== "gowm_spatial_v1") findings.push(`${relative(root, sqlPath)}: non-contract schema ${match[1]} referenced`);
}
for (const required of [
  "gowm_spatial_v1.current_object",
  "gowm_spatial_v1.layer_feature",
  "gowm_spatial_v1.catalog_feature",
  "gowm_spatial_v1.catalog_feature_reference",
  "ST_DWithin",
  "ST_Distance",
  "ST_Covers",
  "ST_Intersects",
  "<->"
]) {
  if (!sql.includes(required)) findings.push(`${relative(root, sqlPath)}: missing required SQL token ${required}`);
}

const repository = readFileSync(repositoryPath, "utf8");
for (const required of [
  "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
  "postgis_lib_version()",
  "set_config('statement_timeout'",
  "set_config('lock_timeout'",
  "gowm_spatial_v1.set_data_scope",
  "gowm_spatial_v1.catalog_snapshot",
  "set_config('gowm.dataset_scope_key'",
  "CONSISTENT_AT_START",
  "AT_LEAST"
]) {
  if (!repository.includes(required)) findings.push(`${relative(root, repositoryPath)}: missing boundary ${required}`);
}
reject(repositoryPath, repository, /\bPINNED\b/u, "current projection falsely claims PINNED");

const migration = readFileSync(migrationPath, "utf8");
for (const required of [
  "WITH (security_barrier = true, security_invoker = false)",
  "ALTER ROLE spatial_provider SET default_transaction_read_only = on",
  "GRANT EXECUTE ON FUNCTION gowm_spatial_v1.set_data_scope(text) TO spatial_provider"
]) {
  if (!migration.includes(required)) findings.push(`${relative(root, migrationPath)}: missing database boundary ${required}`);
}
if (!/REVOKE ALL ON TABLE[\s\S]*?world_object[\s\S]*?spatial_object[\s\S]*?FROM spatial_provider;/u.test(migration)) {
  findings.push(`${relative(root, migrationPath)}: explicit Foundation base-table revocation is missing`);
}
if (!/GRANT SELECT ON[\s\S]*?gowm_spatial_v1\.current_object[\s\S]*?gowm_spatial_v1\.layer_feature[\s\S]*?TO spatial_provider;/u.test(migration)) {
  findings.push(`${relative(root, migrationPath)}: contract-view-only grant is missing`);
}

const catalogFeatureMigration = readFileSync(catalogFeatureMigrationPath, "utf8");
for (const required of [
  "CREATE OR REPLACE VIEW gowm_spatial_v1.catalog_feature",
  "CREATE OR REPLACE VIEW gowm_spatial_v1.catalog_feature_reference",
  "CREATE OR REPLACE VIEW gowm_spatial_v1.catalog_snapshot",
  "CREATE OR REPLACE VIEW gowm_evidence_v1.catalog_feature_geometry",
  "WITH (security_barrier = true, security_invoker = false)",
  "gowm_spatial_v1.catalog_feature_reference",
  "gowm_spatial_v1.catalog_snapshot",
  "TO spatial_provider"
]) {
  if (!catalogFeatureMigration.includes(required)) findings.push(`${relative(root, catalogFeatureMigrationPath)}: missing catalog feature boundary ${required}`);
}
if (!/GRANT SELECT ON[\s\S]*?gowm_evidence_v1\.catalog_feature_geometry[\s\S]*?TO gowm_evidence_reader;/u.test(catalogFeatureMigration)) {
  findings.push(`${relative(root, catalogFeatureMigrationPath)}: evidence contract-view grant is missing`);
}
if (!/GRANT SELECT ON[\s\S]*?gowm_spatial_v1\.catalog_feature[\s\S]*?gowm_spatial_v1\.catalog_feature_reference[\s\S]*?gowm_spatial_v1\.catalog_snapshot[\s\S]*?TO spatial_provider;/u.test(catalogFeatureMigration)) {
  findings.push(`${relative(root, catalogFeatureMigrationPath)}: spatial contract-view grant is missing`);
}
if (!/REVOKE ALL ON TABLE[\s\S]*?spatial_feature_identity[\s\S]*?spatial_feature_version[\s\S]*?FROM gowm_evidence_reader, spatial_provider;/u.test(catalogFeatureMigration)) {
  findings.push(`${relative(root, catalogFeatureMigrationPath)}: explicit catalog base-table revocation is missing`);
}

const sourceLock = JSON.parse(readFileSync(sourceLockPath, "utf8"));
const migrationHash = canonicalTextSha256(migrationPath);
const catalogFeatureMigrationHash = canonicalTextSha256(catalogFeatureMigrationPath);
if (sourceLock.readContractMigrationSha256 !== migrationHash) {
  findings.push(`${relative(root, sourceLockPath)}: migration digest does not match migration 012 bytes`);
}
if (sourceLock.catalogFeatureReadContractMigrationSha256 !== catalogFeatureMigrationHash) {
  findings.push(`${relative(root, sourceLockPath)}: migration digest does not match migration 062 bytes`);
}
if (sourceLock.catalogFeatureReadContractMigration !== catalogFeatureMigrationRelativePath) {
  findings.push(`${relative(root, sourceLockPath)}: migration 062 path does not match the authoritative file`);
}
if (sourceLock.sourceCopiedIntoGowm !== false || sourceLock.license !== "Apache-2.0") {
  findings.push(`${relative(root, sourceLockPath)}: source/license boundary is not locked`);
}

const tracked = execFileSync("git", ["ls-files", "--", ".intake"], { cwd: root, encoding: "utf8" }).trim();
if (tracked) findings.push(".intake: expanded external input is tracked");

if (findings.length > 0) {
  process.stderr.write(`${findings.map((finding) => `SPATIAL_ARCHITECTURE_FAIL ${finding}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("SPATIAL_ARCHITECTURE_PASS\n");
}

function reject(path, source, pattern, message) {
  if (pattern.test(source)) findings.push(`${relative(root, path)}: ${message}`);
}

function canonicalTextSha256(path) {
  const canonical = readFileSync(path, "utf8").replace(/\r\n/gu, "\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}
