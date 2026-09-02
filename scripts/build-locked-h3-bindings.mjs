import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { build, version as esbuildVersion } from "esbuild";

const require = createRequire(import.meta.url);
const option = (key) => { const at = process.argv.indexOf(key); if (at < 0 || !process.argv[at+1]) throw new Error(`${key} is required`); return resolve(process.argv[at+1]); };
const sourceRepository = option("--source-repo"), output = option("--out");
const reportAt = process.argv.indexOf("--report");
const reportPath = reportAt >= 0 && process.argv[reportAt + 1]
  ? resolve(process.argv[reportAt + 1])
  : resolve("reports/gowm-v0.6.2/h3-bindings-build-report.json");
const lockPath = "contracts/manifests/providers/h3-toolkit-source-lock.json";
const lock = JSON.parse(await readFile(lockPath,"utf8"));
if (require("h3-js/package.json").version !== lock.engineVersion || esbuildVersion !== "0.28.2") throw new Error("Pinned build tool/engine version mismatch");
const archive = execFileSync("git", ["-C", sourceRepository,"archive",lock.sourceGitCommit], {maxBuffer:32*1024*1024});
const sha = (b) => `sha256:${createHash("sha256").update(b).digest("hex")}`;
const wrapper = `import * as core from "@h3-toolkit/core";
import * as geometry from "@h3-toolkit/geometry";
import * as neighborhood from "@h3-toolkit/neighborhood";
import * as aggregation from "@h3-toolkit/aggregation";
import * as coverage from "@h3-toolkit/coverage";
import * as flow from "@h3-toolkit/flow";
export function createGowmH3ToolkitBindings() { return {
 pointToCell:core.pointToCell, geometryToCells:geometry.geometryToCells, cellsToGeoJSON:geometry.cellsToGeoJSON,
 gridDisk:neighborhood.gridDisk, getParent:core.getParent, getChildren:core.getChildren, compact:core.compact, uncompact:core.uncompact,
 aggregate:aggregation.aggregate, calculateCoverage:coverage.calculateCoverage, trajectoryToFlow:flow.trajectoryToFlow, aggregateFlow:flow.aggregateFlow,
 selfCheck:() => core.pointToCell({longitude:139.767125,latitude:35.681236},9).index
}; }`;
const builds=[];
for (let pass=0; pass<2; pass++) {
  const dir=await mkdtemp(join(tmpdir(),"gowm-h3-source-build-"));
  execFileSync("tar",["-xf","-","-C",dir],{input:archive});
  const alias=Object.fromEntries(["core","geometry","neighborhood","aggregation","coverage","flow"].map((n)=>[`@h3-toolkit/${n}`,join(dir,`packages/${n}/src/index.ts`)]));
  // Published pure-JavaScript browser build avoids optional Node fs/path loaders;
  // this is the same pinned H3 engine, not a locally reimplemented algorithm.
  alias["h3-js"]=require.resolve("h3-js/dist/browser/h3-js.es.js");
  const result=await build({stdin:{contents:wrapper,resolveDir:dir,sourcefile:"gowm-bindings-entry.ts",loader:"ts"},bundle:true,format:"esm",platform:"node",target:"node22",minify:true,legalComments:"none",write:false,metafile:true,alias});
  if (Object.values(result.metafile.outputs).some((o)=>o.imports.length)) throw new Error("Bindings must have no external imports");
  builds.push(result.outputFiles[0].contents);
}
if (sha(builds[0]) !== sha(builds[1])) throw new Error("Independent source extraction builds are not deterministic");
if (builds[0].length > lock.bindingsArtifactPolicy.maximumBytes) throw new Error("Bindings exceed allowed size");
await mkdir(resolve(output,".."),{recursive:true}); await writeFile(output,builds[0]);
const bindings=(await import(pathToFileURL(output).href)).createGowmH3ToolkitBindings();
if (bindings.selfCheck() !== "892f5a32d97ffff") throw new Error("Locked upstream self-check failed");
const cell=bindings.pointToCell({longitude:116.4,latitude:39.9},9).index;
if (bindings.gridDisk(cell,1).length !== 7 || bindings.getParent(cell,8).resolution !== 8 || !bindings.cellsToGeoJSON([cell]).features.length) throw new Error("Real upstream binding smoke tests failed");
const artifactDigest=sha(builds[0]);
await writeFile(`${output}.LICENSE`, await readFile(require.resolve("h3-js/LICENSE")));
const report={status:"PASS",sourceGitCommit:lock.sourceGitCommit,sourceArchiveHash:sha(archive),engineVersion:lock.engineVersion,engineArtifact:"h3-js/dist/browser/h3-js.es.js",engineArtifactHash:sha(await readFile(require.resolve("h3-js/dist/browser/h3-js.es.js"))),esbuildVersion,wrapperHash:sha(wrapper),artifactDigest,artifactBytes:builds[0].length,independentBuilds:2,externalImports:0,checks:["source-commit-export","pinned-engine","independent-build-byte-equality","self-check","disk","parent","cell-geometry"]};
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath,`${JSON.stringify(report,null,2)}\n`);
if (process.argv.includes("--write-lock")) {
 lock.bindingsArtifactPolicy.approvedArtifactDigests=[artifactDigest];
 lock.bindingsArtifactPolicy.approvalState="VERIFIED_REPRODUCIBLE_BUILD";
 lock.bindingsArtifactPolicy.evidence=reportPath;
 await writeFile(lockPath,`${JSON.stringify(lock,null,2)}\n`);
}
process.stdout.write(`${JSON.stringify(report)}\n`);
