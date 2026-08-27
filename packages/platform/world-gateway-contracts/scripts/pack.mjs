import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { buildConsumerContracts } from "./build.mjs";

const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const destination = resolve(packageRoot, "dist");
await buildConsumerContracts();
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("npm_execpath is required to create the package archive");
const result = spawnSync(process.execPath, [npmCli, "pack", "--json", "--pack-destination", destination], { cwd: packageRoot, encoding: "utf8" });
if (result.status !== 0) throw new Error(result.stderr || result.error?.message || `npm pack failed with status ${result.status}`);
process.stdout.write(result.stdout);
