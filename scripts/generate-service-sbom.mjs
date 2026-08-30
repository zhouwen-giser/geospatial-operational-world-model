import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { register } from "tsx/esm/api";

register();
const { compareUnicodeCodePoints } = await import("../packages/platform/contract-runtime/src/canonical-order.ts");

const lock=JSON.parse(await readFile("package-lock.json","utf8"));const components=[];
for(const [path,value] of Object.entries(lock.packages??{})){if(!path||!value||typeof value!=="object")continue;const name=value.name??path.replace(/^node_modules\//u,"");if(!name||!value.version)continue;const scope=name.startsWith("@")?name.slice(1).split("/")[0]:undefined,pkgName=name.startsWith("@")?name.split("/")[1]:name;components.push({type:"library",name:pkgName,...(scope?{group:scope}:{}),version:value.version,"bom-ref":`pkg:npm/${encodeURIComponent(name)}@${value.version}`,...(value.license?{licenses:[{license:{id:value.license}}]}:{})});}
components.sort((a,b)=>compareUnicodeCodePoints(a["bom-ref"],b["bom-ref"]));const version=String(lock.version);const serial=createHash("sha256").update(JSON.stringify(components)).digest("hex").slice(0,32);const bom={bomFormat:"CycloneDX",specVersion:"1.6",serialNumber:`urn:uuid:${serial.slice(0,8)}-${serial.slice(8,12)}-${serial.slice(12,16)}-${serial.slice(16,20)}-${serial.slice(20)}`,version:1,metadata:{timestamp:new Date().toISOString(),tools:{components:[{type:"application",name:"gowm-service-sbom-generator",version:"1.0.0"}]},component:{type:"application",name:"geospatial-operational-world-model",version,"bom-ref":`pkg:npm/geospatial-operational-world-model@${version}`}},components};await writeFile("reports/gowm-v0.5/service-sbom.cdx.json",`${JSON.stringify(bom,null,2)}\n`);process.stdout.write(`SERVICE_SBOM_GENERATED components=${components.length}\n`);
