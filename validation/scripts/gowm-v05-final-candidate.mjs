import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const version=(await readFile("VERSION","utf8")).trim();
const packageDocument=JSON.parse(await readFile("package.json","utf8"));
const lockDocument=JSON.parse(await readFile("package-lock.json","utf8"));
const acceptance=JSON.parse(await readFile("reports/gowm-v0.5/final-acceptance.json","utf8"));
const sync=JSON.parse(await readFile("reports/gowm-v0.5/sync-state.json","utf8"));
const report=await readFile("reports/gowm-v0.5/final-stable-candidate.md","utf8");
const rows=parseCsv(await readFile("GOWM_Network_Basic_Routing_v0.5_Codex_Goal/acceptance/acceptance-matrix.csv","utf8"));
const requiredIds=rows.filter(row=>row.required==="yes").map(row=>row.id).sort();
const passedIds=acceptance.passedRanges.flatMap(expandRange).sort();

assert.equal(version,"0.5.0");assert.equal(packageDocument.version,version);assert.equal(lockDocument.version,version);assert.equal(lockDocument.packages[""].version,version);
assert.equal(requiredIds.length,154);assert.equal(acceptance.requiredCases,154);assert.equal(acceptance.passedCases,154);assert.equal(acceptance.failedCases,0);assert.equal(acceptance.blockedCases,0);assert.equal(acceptance.notRunCases,0);assert.deepEqual(passedIds,requiredIds);
assert.deepEqual(acceptance.optional,[{id:"AC-R027",status:"NOT_RUN_OPTIONAL"}]);
assert.equal(sync.status,"COMPLETE");assert.equal(sync.targetVersion,version);assert.equal(sync.milestones.networkReady,true);assert.equal(sync.milestones.routingReady,true);assert.equal(sync.milestones.stableCandidate,true);
for(const marker of ["NETWORK_READY","ROUTING_READY","GOWM_NETWORK_ROUTING_V0_5_STABLE_CANDIDATE_COMPLETE"])assert.ok(report.includes(`\`${marker}\``));
assert.ok(report.includes("Draft PR #3"));assert.ok(report.includes("NOT_RUN"));
process.stdout.write("GOWM_NETWORK_ROUTING_V0_5_STABLE_CANDIDATE_COMPLETE cases=154 passed=154 blocked=0 failed=0 notRun=0\n");

function expandRange(value){const match=/^(AC-[A-Z])(\d{3})\.\.(?:AC-)?[A-Z]?(\d{3})$/u.exec(value);if(!match)return[value];const [,prefix,start,end]=match;return Array.from({length:Number(end)-Number(start)+1},(_,index)=>`${prefix}${String(Number(start)+index).padStart(3,"0")}`);}
function parseCsv(value){const lines=value.trim().split(/\r?\n/u);const headers=parseLine(lines.shift());return lines.map(line=>Object.fromEntries(parseLine(line).map((field,index)=>[headers[index],field])));}
function parseLine(line=""){const fields=[];let field="",quoted=false;for(let index=0;index<line.length;index+=1){const character=line[index];if(character==='"'){if(quoted&&line[index+1]==='"'){field+='"';index+=1;}else quoted=!quoted;}else if(character===","&&!quoted){fields.push(field);field="";}else field+=character;}fields.push(field);return fields;}
