import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runId = process.env.GOWM_V05_RUN_ID;
if (process.env.ALLOW_GOWM_DB_RUNTIME_GATE !== "YES") {
  throw new Error("Set ALLOW_GOWM_DB_RUNTIME_GATE=YES to build and start the isolated certification database");
}
if (!runId || !/^[a-z0-9][a-z0-9-]{2,31}$/u.test(runId)) {
  throw new Error("GOWM_V05_RUN_ID must be a unique 3-32 character lowercase alphanumeric/hyphen identifier");
}

const project = `gowmv05-${runId}`;
const image = "gowm-plus-db:18-3.6-mobilitydb-1.3-h3-4.5.0-pgrouting-4.0.1";
const postgresPassword = "gowm_v05_local_test";
const environment = {
  ...process.env,
  COMPOSE_PROJECT_NAME: project,
  POSTGRES_PASSWORD: postgresPassword,
  STAS_DB_PASSWORD: "gowm_v05_stas_local_test"
};
const evidence = {
  schemaVersion: "1.0",
  runId,
  project,
  startedAt: new Date().toISOString(),
  status: "RUNNING",
  commands: [],
  versions: null,
  image: null,
  errors: []
};

function run(command, args, options = {}) {
  const startedAt = Date.now();
  const evidenceCommand = options.evidenceCommand ?? [command, ...args];
  try {
    const stdout = execFileSync(command, args, {
      cwd: repositoryRoot,
      env: environment,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: options.input ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
      input: options.input
    });
    evidence.commands.push({ command: evidenceCommand, status: "PASS", elapsedMs: Date.now() - startedAt });
    return stdout.trim();
  } catch (error) {
    evidence.commands.push({ command: evidenceCommand, status: "FAIL", elapsedMs: Date.now() - startedAt });
    evidence.errors.push(String(error.stderr || error.message || error));
    throw error;
  }
}

async function persist() {
  evidence.finishedAt = new Date().toISOString();
  const directory = resolve(repositoryRoot, "reports/gowm-v0.5");
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, `d00-runtime-${runId}.json`), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
}

try {
  run("docker", ["compose", "config", "--quiet"]);
  run("docker", ["compose", "build", "postgres"]);
  run("docker", ["compose", "up", "--detach", "postgres"]);

  let containerId = "";
  for (let attempt = 0; attempt < 60; attempt += 1) {
    containerId = run("docker", ["compose", "ps", "--quiet", "postgres"]);
    if (containerId) {
      const health = run("docker", ["inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}", containerId]);
      if (health === "healthy") break;
      if (health === "unhealthy" || health === "exited" || health === "dead") throw new Error(`database entered terminal state ${health}`);
    }
    const wait = spawnSync(process.execPath, ["-e", "setTimeout(()=>{},2000)"], { stdio: "ignore" });
    if (wait.status !== 0) throw new Error("health wait failed");
  }
  if (!containerId) throw new Error("database container was not created");
  const finalHealth = run("docker", ["inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}", containerId]);
  if (finalHealth !== "healthy") throw new Error(`database did not become healthy: ${finalHealth}`);

  const psqlArgs = ["compose", "exec", "--no-TTY", "postgres", "psql", "--username", "gowm", "--dbname", "gowm", "--set", "ON_ERROR_STOP=on"];
  const migrationFiles = (await readdir(resolve(repositoryRoot, "database/migrations")))
    .filter((name) => /^\d{3}_.+\.sql$/u.test(name) && Number(name.slice(0, 3)) <= 32)
    .sort();
  for (const file of migrationFiles) {
    const template = await readFile(resolve(repositoryRoot, "database/migrations", file), "utf8");
    const migration = template
      .replaceAll(":ANALYSIS_SRID", "32650")
      .replaceAll(":TRACKLET_MAX_TIME_GAP_MS", "10000")
      .replaceAll(":TRACKLET_MAX_DISTANCE_GAP_M", "250")
      .replaceAll(":TRACKLET_MAX_REQUIRED_SPEED_MPS", "80");
    run("docker", psqlArgs, { input: migration, evidenceCommand: ["baseline-migration", file] });
  }
  const assertionFiles = (await readdir(resolve(repositoryRoot, "database/tests")))
    .filter((name) => /^\d{3}_.+_assertions\.sql$/u.test(name) && Number(name.slice(0, 3)) <= 21)
    .sort();
  for (const file of assertionFiles) {
    const assertion = (await readFile(resolve(repositoryRoot, "database/tests", file), "utf8"))
      .split(/\r?\n/u)
      .filter((line) => !line.trimStart().startsWith("\\"))
      .join("\n");
    run("docker", psqlArgs, { input: assertion, evidenceCommand: ["baseline-assertion", file] });
  }

  const sql = await readFile(resolve(repositoryRoot, "database/tests/022_pgrouting_runtime_assertions.sql"), "utf8");
  const output = run("docker", ["compose", "exec", "--no-TTY", "postgres", "psql", "--username", "gowm", "--dbname", "gowm", "--tuples-only", "--no-align"], { input: sql });
  const versionLine = output.split(/\r?\n/u).map((line) => line.trim()).find((line) => line.startsWith("{") && line.includes("pgrouting"));
  if (!versionLine) throw new Error(`version evidence not found in psql output: ${output}`);
  evidence.versions = JSON.parse(versionLine);

  const imageId = run("docker", ["image", "inspect", "--format", "{{.Id}}", image]);
  const labels = JSON.parse(run("docker", ["image", "inspect", "--format", "{{json .Config.Labels}}", image]));
  const notice = run("docker", ["run", "--rm", "--entrypoint", "test", image, "-s", "/usr/share/doc/gowm-pgrouting/LICENSE"]);
  evidence.image = { name: image, contentDigest: imageId, labels, licensePresent: notice === "" };
  evidence.status = "PASS";
  await persist();
  process.stdout.write(`GOWM_NETWORK_DB_RUNTIME_PASS ${runId} ${imageId}\n`);
} catch (error) {
  evidence.status = "FAIL";
  evidence.errors.push(String(error?.message ?? error));
  await persist();
  throw error;
}
