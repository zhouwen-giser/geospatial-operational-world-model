import { loadSampleWorldDatabase, mutateSampleWorldDatabase, resetSampleWorldDatabase } from "./database.js";

async function main(command: string): Promise<void> {
  switch (command) {
    case "load-db":
      await loadSampleWorldDatabase();
      return;
    case "mutate-db":
      await mutateSampleWorldDatabase();
      return;
    case "reset-db":
      await resetSampleWorldDatabase({ dryRun: process.argv.includes("--dry-run") });
      return;
    default:
      throw new Error(`Unknown sample-world database command: ${command}`);
  }
}

main(process.argv[2] ?? "").catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
