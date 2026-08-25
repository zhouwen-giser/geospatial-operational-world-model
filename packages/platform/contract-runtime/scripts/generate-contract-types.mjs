import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../../../..");
const contractRoots = [
  resolve(repositoryRoot, "contracts/platform"),
  resolve(repositoryRoot, "contracts/capabilities"),
  resolve(repositoryRoot, "contracts/gowm-v0.4"),
  resolve(repositoryRoot, "contracts/gowm-v0.5"),
  resolve(repositoryRoot, "contracts/gowm-v0.6")
];
const generatedDirectory = resolve(repositoryRoot, "packages/platform/contract-runtime/src/generated");
const contractsOutput = resolve(generatedDirectory, "contracts.ts");
const bundleOutput = resolve(generatedDirectory, "schema-bundle.ts");
const hashesOutput = resolve(generatedDirectory, "schema-hashes.ts");

const toPosix = (value) => value.replaceAll("\\", "/");
const canonicalJson = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
};
const pascal = (value) =>
  value
    .replace(/\.schema\.json$/u, "")
    .split(/[^A-Za-z0-9]+/u)
    .filter(Boolean)
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join("");

async function collectSchemaFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectSchemaFiles(path)));
    } else if (entry.name.endsWith(".schema.json")) {
      files.push(path);
    }
  }
  return files;
}

const files = (await Promise.all(contractRoots.map(collectSchemaFiles)))
  .flat()
  .sort((left, right) => toPosix(relative(repositoryRoot, left)).localeCompare(toPosix(relative(repositoryRoot, right))));

const documents = new Map();
for (const path of files) {
  const key = toPosix(relative(resolve(repositoryRoot, "contracts"), path));
  documents.set(key, JSON.parse(await readFile(path, "utf8")));
}

const typeNames = new Map();
for (const [key, schema] of documents) {
  const rootName = schema.title || pascal(key);
  typeNames.set(`${key}#`, rootName);
  for (const definitionName of Object.keys(schema.$defs ?? {}).sort()) {
    const definition = schema.$defs[definitionName];
    typeNames.set(
      `${key}#/$defs/${definitionName}`,
      definition.title || `${rootName}${pascal(definitionName)}`
    );
  }
}

function resolveReferenceKey(currentKey, reference) {
  if (reference.startsWith("#")) return `${currentKey}${reference}`;
  const [filePart, fragment = ""] = reference.split("#", 2);
  const normalized = posix.normalize(posix.join(posix.dirname(currentKey), filePart));
  return `${normalized}#${fragment}`;
}

function literal(value) {
  if (value === null) return "null";
  return JSON.stringify(value);
}

function schemaToType(schema, currentKey) {
  if (schema === true) return "unknown";
  if (schema === false) return "never";
  if (!schema || Object.keys(schema).length === 0) return "unknown";
  if (schema.$ref) {
    const targetKey = resolveReferenceKey(currentKey, schema.$ref);
    const name = typeNames.get(targetKey);
    if (!name) throw new Error(`Unresolved type reference ${schema.$ref} from ${currentKey}`);
    return name;
  }
  if (Object.hasOwn(schema, "const")) return literal(schema.const);
  if (schema.enum) return schema.enum.map(literal).join(" | ");
  for (const [keyword, separator] of [["oneOf", " | "], ["anyOf", " | "], ["allOf", " & "]]) {
    if (!schema[keyword]) continue;
    const { [keyword]: branches, ...base } = schema;
    const hasStructuralBase = ["type", "properties", "required", "additionalProperties", "patternProperties", "items", "prefixItems"]
      .some((name) => Object.hasOwn(base, name));
    if (hasStructuralBase && (keyword === "oneOf" || keyword === "anyOf")) {
      return branches.map((item) => {
        const merged = {
          ...base,
          ...item,
          properties: { ...(base.properties ?? {}), ...(item.properties ?? {}) },
          required: [...new Set([...(base.required ?? []), ...(item.required ?? [])])]
        };
        return `(${schemaToType(merged, currentKey)})`;
      }).join(separator);
    }
    const branchType = branches.map((item) => `(${schemaToType(item, currentKey)})`).join(separator);
    return hasStructuralBase ? `(${schemaToType(base, currentKey)}) & (${branchType})` : branchType;
  }
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length > 1) {
    return types.map((type) => schemaToType({ ...schema, type }, currentKey)).join(" | ");
  }
  switch (types[0]) {
    case "null":
      return "null";
    case "boolean":
      return "boolean";
    case "integer":
    case "number":
      return "number";
    case "string":
      return "string";
    case "array": {
      if (Array.isArray(schema.prefixItems)) {
        const tupleItems = schema.prefixItems.map((item) => schemaToType(item, currentKey));
        if (schema.minItems === tupleItems.length && schema.maxItems === tupleItems.length) {
          return `[${tupleItems.join(", ")}]`;
        }
        const remainder = schema.items === false ? [] : [`...Array<${schemaToType(schema.items ?? {}, currentKey)}>`];
        return `[${[...tupleItems, ...remainder].join(", ")}]`;
      }
      if (
        Number.isInteger(schema.minItems) &&
        Number.isInteger(schema.maxItems) &&
        schema.minItems >= 0 &&
        schema.maxItems >= schema.minItems &&
        schema.maxItems <= 8
      ) {
        const itemType = schemaToType(schema.items ?? {}, currentKey);
        const tupleTypes = [];
        for (let length = schema.minItems; length <= schema.maxItems; length += 1) {
          tupleTypes.push(`[${Array.from({ length }, () => itemType).join(", ")}]`);
        }
        return tupleTypes.join(" | ");
      }
      return `Array<${schemaToType(schema.items ?? {}, currentKey)}>`;
    }
    case "object":
    case undefined: {
      const properties = schema.properties ?? {};
      const required = new Set(schema.required ?? []);
      const fields = Object.keys(properties)
        .sort()
        .map((name) => {
          const propertyName = /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(name) ? name : JSON.stringify(name);
          return `  ${propertyName}${required.has(name) ? "" : "?"}: ${schemaToType(properties[name], currentKey)};`;
        });
      const patternTypes = Object.values(schema.patternProperties ?? {}).map((item) => schemaToType(item, currentKey));
      const additionalType = schema.additionalProperties && schema.additionalProperties !== true
        ? schemaToType(schema.additionalProperties, currentKey)
        : undefined;
      const dynamicTypes = [...new Set([...patternTypes, ...(additionalType ? [additionalType] : [])])];
      if (fields.length === 0 && dynamicTypes.length > 0) {
        return `Record<string, ${dynamicTypes.join(" | ")}>`;
      }
      if (fields.length > 0 && dynamicTypes.length > 0) {
        const propertyTypes = Object.values(properties).map((item) => schemaToType(item, currentKey));
        return `{\n${fields.join("\n")}\n} & Record<string, ${[...new Set([...propertyTypes, ...dynamicTypes])].join(" | ")}>`;
      }
      if (schema.additionalProperties === true && fields.length > 0) {
        return `{\n${fields.join("\n")}\n} & Record<string, unknown>`;
      }
      if (schema.additionalProperties === true || (schema.additionalProperties === undefined && fields.length === 0)) {
        return "Record<string, unknown>";
      }
      return fields.length === 0 ? "Record<string, never>" : `{\n${fields.join("\n")}\n}`;
    }
    default:
      return "unknown";
  }
}

const declarations = [];
for (const [key, schema] of documents) {
  const rootName = typeNames.get(`${key}#`);
  declarations.push(`export type ${rootName} = ${schemaToType(schema, key)};`);
  for (const definitionName of Object.keys(schema.$defs ?? {}).sort()) {
    const name = typeNames.get(`${key}#/$defs/${definitionName}`);
    declarations.push(`export type ${name} = ${schemaToType(schema.$defs[definitionName], key)};`);
  }
}

const contractsSource = `// Generated by scripts/generate-contract-types.mjs. Do not edit.\n\n${declarations.join("\n\n")}\n`;
const schemaObject = Object.fromEntries(documents);
const bundleSource = `// Generated by scripts/generate-contract-types.mjs. Do not edit.\n\nexport const contractSchemas: Readonly<Record<string, unknown>> = ${JSON.stringify(schemaObject, null, 2)};\n`;
const schemaHashes = Object.fromEntries(
  [...documents].map(([key, schema]) => [key, `sha256:${createHash("sha256").update(canonicalJson(schema), "utf8").digest("hex")}`])
);
const hashesSource = `// Generated by scripts/generate-contract-types.mjs. Do not edit.\n\nexport const contractSchemaHashes: Readonly<Record<string, string>> = ${JSON.stringify(schemaHashes, null, 2)};\n`;

const check = process.argv.includes("--check");
if (check) {
  const currentContracts = await readFile(contractsOutput, "utf8").catch(() => "");
  const currentBundle = await readFile(bundleOutput, "utf8").catch(() => "");
  const currentHashes = await readFile(hashesOutput, "utf8").catch(() => "");
  if (currentContracts !== contractsSource || currentBundle !== bundleSource || currentHashes !== hashesSource) {
    process.stderr.write("Generated contract artifacts are stale. Run generate-contract-types.mjs.\n");
    process.exitCode = 1;
  }
} else {
  await mkdir(generatedDirectory, { recursive: true });
  await writeFile(contractsOutput, contractsSource, "utf8");
  await writeFile(bundleOutput, bundleSource, "utf8");
  await writeFile(hashesOutput, hashesSource, "utf8");
}
