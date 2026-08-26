"""Export the existing STAS OpenAPI contract, without changing its algorithms."""
import hashlib
import json
from pathlib import Path
import sys
import yaml

root = Path(__file__).resolve().parents[1]
source = root / "services/stas/openapi/openapi.yaml"
schemas = yaml.safe_load(source.read_text())["components"]["schemas"]

def convert(value):
    if isinstance(value, dict):
        return {k: (v.replace("#/components/schemas/", "#/$defs/") if k == "$ref" else convert(v)) for k, v in value.items()}
    if isinstance(value, list):
        return [convert(v) for v in value]
    return value

definitions = convert(schemas)
for name, schema in definitions.items():
    schema["title"] = "StasNative" + "".join(part.capitalize() for part in name.split("_"))
native = {"$schema": "https://json-schema.org/draft/2020-12/schema", "$id": "urn:gowm:v0.6.2:stas-native", "title": "StasNativeContracts", "$defs": definitions}
out = root / "contracts/capabilities/stas"
artifacts = {out / "native.schema.json": native}
for name in schemas:
    if not name.endswith("_input_v1"):
        continue
    operation = "stas." + name.removesuffix("_input_v1").replace("_", "-")
    artifacts[out / (operation + ".input.schema.json")] = {"$schema": native["$schema"], "$id": f"urn:gowm:capability:{operation}:input:1.0", "title": "Stas" + definitions[name]["title"] + "Input", "$ref": f"native.schema.json#/$defs/{name}"}
artifacts[out / "analysis-result.schema.json"] = {"$schema": native["$schema"], "$id": "urn:gowm:capability:stas:output:1.0", "title": "StasProviderAnalysisResult", "$ref": "native.schema.json#/$defs/AnalysisResult"}
artifacts[out / "source-lock.json"] = {"schemaVersion": "1.0", "sourceKind": "IN_TREE_NATIVE_CONTRACT", "source": str(source.relative_to(root)), "sha256": hashlib.sha256(source.read_bytes()).hexdigest(), "refinements": "Native executable Zod validation remains mandatory in the adapter."}
for path, value in artifacts.items():
    text = json.dumps(value, indent=2) + "\n"
    if "--check" in sys.argv:
        if not path.exists() or path.read_text() != text:
            raise RuntimeError(f"Stale STAS contract: {path.relative_to(root)}")
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
print(f"STAS_CONTRACTS_PASS artifacts={len(artifacts)}")
