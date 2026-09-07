import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

const [image, context] = process.argv.slice(2);
if (!image || !context) throw new Error("Usage: node scripts/verify-deployment-image.mjs <image> <verified-build-context>");
const root = resolve(context);
const files = {};
function add(path) {
  files[path] = createHash("sha256").update(readFileSync(join(root, path))).digest("hex");
}
function walk(path) {
  for (const entry of readdirSync(join(root, path), { withFileTypes: true })) {
    const child = `${path}/${entry.name}`;
    if (entry.isDirectory()) walk(child);
    else if (entry.isFile()) add(child);
    else throw new Error(`Non-regular build context entry: ${child}`);
  }
}
for (const path of ["package.json", "package-lock.json", "services/stas/package.json", "services/stas/package-lock.json"]) add(path);
for (const path of ["database", "config", "contracts", "scripts"]) walk(path);
// Expected hashes come from the independently verified host context, never from
// another image layer. A stale COPY must fail even when Docker reports success.
const check = `
  import fs from 'node:fs';
  import crypto from 'node:crypto';
  let input=''; for await (const chunk of process.stdin) input+=chunk;
  const expected=JSON.parse(input), mismatches=[];
  for (const [path, hash] of Object.entries(expected)) {
    try {
      const actual=crypto.createHash('sha256').update(fs.readFileSync('/app/'+path)).digest('hex');
      if (actual!==hash) mismatches.push(path);
    } catch { mismatches.push(path); }
  }
  if (mismatches.length) throw new Error('Image source-byte mismatch: '+mismatches.join(', '));
  const {createOperationalRealityProvider}=await import('/app/dist/services/providers/operational-reality-provider/src/provider.js');
  const actual=createOperationalRealityProvider({pool:{}}).runtime.manifest;
  const declared=JSON.parse(fs.readFileSync('/app/contracts/manifests/providers/operational-reality-provider.json','utf8'));
  if (JSON.stringify(actual)!==JSON.stringify(declared)) throw new Error('Image manifest/runtime mismatch');
  const {createGroundingCatalogProvider}=await import('/app/dist/services/providers/grounding-catalog-provider/src/provider.js');
  const reference=createGroundingCatalogProvider({mode:'reference',pool:{},cursorSecret:'image-identity-verification-only'}).runtime.manifest;
  const referenceDeclared=JSON.parse(fs.readFileSync('/app/contracts/manifests/providers/reference-catalog-provider.json','utf8'));
  if (JSON.stringify(reference)!==JSON.stringify(referenceDeclared)) throw new Error('Reference manifest/runtime mismatch');
  if (process.getuid()===0) throw new Error('Runtime must be non-root');
  console.log(JSON.stringify({status:'PASS',gate:'IMAGE_SOURCE_AND_RUNTIME_IDENTITY',files:Object.keys(expected).length,
    implementationDigest:actual.provider.implementationDigest,referenceImplementationDigest:reference.provider.implementationDigest}));
`;
process.stdout.write(execFileSync("docker", ["run", "--rm", "--network", "none", "--read-only", "-i",
  "--entrypoint", "node", image, "--input-type=module", "-e", check], {
  input: JSON.stringify(files), encoding: "utf8", maxBuffer: 4 * 1024 * 1024
}));
