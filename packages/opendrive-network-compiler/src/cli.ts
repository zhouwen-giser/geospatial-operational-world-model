#!/usr/bin/env node
import { compileOpenDriveArtifacts } from "./artifacts.js";
import { DEFAULT_OUTPUT_ROOT } from "./compiler.js";

async function main(): Promise<void> {
  const [command, sourceArgument, oracleArgument, outputArgument] = process.argv.slice(2);
  if (command !== "compile") throw new Error("usage: cli.js compile [<xodr> <oracle> <output-dir>]");
  const sourcePath = sourceArgument ?? process.env.OPENDRIVE_SOURCE_PATH; const oraclePath = oracleArgument ?? process.env.OPENDRIVE_GEOREF_ORACLE_PATH;
  const outputRoot = outputArgument ?? process.env.GOWM_OPENDRIVE_OUTPUT_ROOT ?? DEFAULT_OUTPUT_ROOT;
  if (!sourcePath || !oraclePath) throw new Error("OPENDRIVE_SOURCE_PATH and OPENDRIVE_GEOREF_ORACLE_PATH (or positional arguments) are required");
  const result = await compileOpenDriveArtifacts({ sourcePath, oraclePath, outputRoot });
  process.stdout.write(`${JSON.stringify({ status: "PASS", manifest: result.manifest }, null, 2)}\n`);
}

main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exitCode = 1; });
