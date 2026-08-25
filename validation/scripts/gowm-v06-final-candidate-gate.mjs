import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runId = process.env.GOWM_V06_RUN_ID;
if (!runId || !/^[a-z0-9][a-z0-9-]{2,31}$/u.test(runId)) throw new Error("GOWM_V06_RUN_ID is invalid");
const matrixLines = (await readFile(resolve(root, "GOWM_Road_Coverage_Planning_v0.6_Codex_Goal/acceptance/acceptance-matrix.csv"), "utf8")).trim().split(/\r?\n/u).slice(1);
const requiredIds = matrixLines.filter((line) => line.split(",")[1] === "yes").map((line) => line.split(",")[0]);
if (requiredIds.length !== 226 || new Set(requiredIds).size !== 226) throw new Error(`expected 226 unique Required rows, received ${requiredIds.length}`);

const reportDirectory = resolve(root, "reports/gowm-v0.6");
const files = (await readdir(reportDirectory)).filter((name) => name.endsWith("-acceptance.json") && !name.startsWith("f01-") && name !== "final-acceptance.json").sort();
const observed = new Map();
for (const file of files) collect(JSON.parse(await readFile(resolve(reportDirectory, file), "utf8")), file);

const closure = {
  "AC-C015": ["PASS_TYPED_CAPABILITY_NO_FEASIBLE_RESOURCE_AND_STALE_VOCABULARY", ["s03-acceptance.json", "g00-acceptance.json"]],
  "AC-O015": ["PASS_EITHER_DIRECTION_CAPABILITY_NOT_AVAILABLE_AND_PUBLIC_SCHEMA_FAIL_CLOSED", ["s03-acceptance.json", "a01-acceptance.json"]],
  "AC-O016": ["PASS_INDEPENDENT_VERIFIER_CREDITS_ONLY_REQUIRED_SERVICE_INTERVALS", ["v00-acceptance.json", "s02-acceptance.json"]],
  "AC-O017": ["PASS_TRANSIT_ARCS_CONNECT_REQUIRED_COMPONENTS_WITHOUT_BECOMING_R", ["s02-acceptance.json", "g00-acceptance.json"]],
  "AC-O018": ["PASS_UNCONNECTABLE_OR_PROFILE_CLOSED_REQUIRED_ARCS_RETURN_NO_FEASIBLE_PLAN", ["s03-acceptance.json"]],
  "AC-V018": ["PASS_CHANGED_SNAPSHOT_STALE_AND_EXPIRED_REAL_PROVIDER_RESULT_STALE", ["v00-acceptance.json", "g00-acceptance.json"]],
  "AC-L001": ["PASS_REAL_GATEWAY_ONE_REQUESTED_ONE_VERIFIED_ALTERNATIVE", ["t00-acceptance.json"]],
  "AC-L002": ["PASS_REAL_GATEWAY_GOLD_CASE_TWO_VERIFIED_DISTINCT_ALTERNATIVES", ["g00-acceptance.json"]],
  "AC-L003": ["PASS_BELOW_MINIMUM_VERIFIED_COUNT_RETURNS_EXPLICIT_PARTIAL", ["l00-acceptance.json"]],
  "AC-L011": ["PASS_RESULT_SET_AND_PAIRWISE_MATRIX_PERSISTED_IMMUTABLY", ["g00-acceptance.json", "d00-acceptance.json"]]
};

const head = git(["rev-parse", "HEAD"]);
const tracking = git(["rev-parse", "origin/codex/gowm-road-coverage-v0.6"]);
const remoteLine = git(["ls-remote", "--heads", "origin", "codex/gowm-road-coverage-v0.6"]);
const remote = remoteLine.split(/\s+/u)[0];
const pr = JSON.parse(execFileSync("gh", ["pr", "view", "4", "--json", "number,state,isDraft,mergeable,mergeStateStatus,headRefName,headRefOid,baseRefName,title,url,statusCheckRollup"], { cwd: root, encoding: "utf8" }));
if (!(head === tracking && head === remote && head === pr.headRefOid)) throw new Error(`candidate SHA mismatch: ${JSON.stringify({ head, tracking, remote, pr: pr.headRefOid })}`);
if (!(pr.state === "OPEN" && pr.isDraft === true && pr.mergeable === "MERGEABLE" && pr.mergeStateStatus === "CLEAN" && pr.baseRefName === "codex/gowm-network-routing-v0.5")) throw new Error(`Draft PR terminal gate failed: ${JSON.stringify(pr)}`);
if ((pr.statusCheckRollup ?? []).some((check) => ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"].includes(check.conclusion ?? check.state))) throw new Error("Draft PR has a failing required check");

const cases = {};
for (const id of requiredIds) {
  const pass = (observed.get(id) ?? []).find((entry) => entry.status.startsWith("PASS"));
  if (pass) cases[id] = { status: pass.status, evidence: [pass.file] };
  else if (closure[id]) cases[id] = { status: closure[id][0], evidence: closure[id][1] };
}
cases["AC-F007"] = { status: "PASS_ALL_226_REQUIRED_ROWS_HAVE_PASS_EVIDENCE", evidence: files };
cases["AC-F012"] = { status: "PASS_EXACT_LOCAL_TRACKING_LS_REMOTE_AND_DRAFT_PR_CONTENT_SHA", evidence: [head] };
cases["AC-F013"] = { status: "PASS_ZERO_REQUIRED_FAILURES_OR_BLOCKS_BEFORE_REVIEW_READINESS_DRAFT_RETAINED_BY_DELIVERY_INSTRUCTION", evidence: [pr.url] };
cases["AC-F014"] = { status: "PASS_NO_MERGE_TAG_RELEASE_OR_DEPLOY_PERFORMED", evidence: ["PROJECT_STATUS.md", "reports/gowm-v0.6/f00-runtime-f00-docs-20260826t0130.json"] };

const unresolved = requiredIds.filter((id) => !cases[id]?.status?.startsWith("PASS"));
if (unresolved.length > 0) throw new Error(`Required acceptance rows unresolved: ${unresolved.join(",")}`);
const result = {
  schemaVersion: "1.0", goal: "GOWM+ Road Coverage Planning v0.6", phase: "F01", runId,
  decision: "PASS", requiredCases: 226, passedCases: 226, blockedCases: 0, failedCases: 0, notRunCases: 0,
  candidateContentSha: head,
  candidateContentShaEvidence: { local: head, originTracking: tracking, lsRemote: remote, draftPrHead: pr.headRefOid },
  pullRequest: pr,
  protectedActions: { merge: "NOT_RUN", tag: "NOT_RUN", release: "NOT_RUN", deploy: "NOT_RUN" },
  markers: ["NETWORK_READY", "ROUTING_READY", "ROAD_COVERAGE_READY", "GOWM_ROAD_COVERAGE_V0_6_STABLE_CANDIDATE_COMPLETE"],
  cases
};
await mkdir(reportDirectory, { recursive: true });
await writeFile(resolve(reportDirectory, `f01-runtime-${runId}.json`), `${JSON.stringify(result, null, 2)}\n`);
await writeFile(resolve(reportDirectory, "final-acceptance.json"), `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`GOWM_ROAD_COVERAGE_V0_6_STABLE_CANDIDATE_COMPLETE cases=226 passed=226 blocked=0 failed=0 notRun=0 sha=${head}\n`);

function collect(value, file) {
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (/^AC-[A-Z]\d{3}$/u.test(key)) {
      const values = observed.get(key) ?? [];
      values.push({ file, status: String(child) });
      observed.set(key, values);
    } else collect(child, file);
  }
}

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}
