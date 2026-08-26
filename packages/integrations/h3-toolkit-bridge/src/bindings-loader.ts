import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { LockedExternalH3ToolkitBindings } from "./external-toolkit-adapter.js";
import type { Sha256Digest } from "./types.js";
const MAX_BINDINGS_MODULE_BYTES = 8 * 1024 * 1024;

/** Hash-verified self-contained loader; deployment callers must enforce the committed approval allowlist. */
export async function loadVerifiedH3Bindings(
  modulePath: string,
  expectedDigest: Sha256Digest,
  temporaryRoot = tmpdir()
): Promise<LockedExternalH3ToolkitBindings> {
  const bytes = await readVerifiedModule(modulePath, expectedDigest);
  const stagingDirectory = await mkdtemp(join(temporaryRoot, "gowm-h3-bindings-"));
  const stagedPath = join(stagingDirectory, "verified-bindings.mjs");
  let loaded: Record<string, unknown>;
  try {
    await writeFile(stagedPath, bytes, { flag: "wx", mode: 0o500 });
    loaded = await import(`${pathToFileURL(stagedPath).href}?digest=${expectedDigest.slice("sha256:".length)}`) as Record<string, unknown>;
  } finally {
    await rm(stagingDirectory, { force: true, recursive: true });
  }
  const factory = loaded.createGowmH3ToolkitBindings;
  const candidate = typeof factory === "function"
    ? await (factory as () => unknown | Promise<unknown>)()
    : loaded.gowmH3ToolkitBindings ?? loaded.default;
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("H3 Toolkit bindings module must export createGowmH3ToolkitBindings, gowmH3ToolkitBindings, or default bindings");
  }
  return candidate as LockedExternalH3ToolkitBindings;
}

async function readVerifiedModule(modulePath: string, expectedDigest: Sha256Digest): Promise<Buffer> {
  const pathStat = await lstat(modulePath);
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
    throw new Error("H3 Toolkit bindings artifact must be a regular non-symlink file");
  }
  const noFollow = (constants as unknown as Record<string, number | undefined>).O_NOFOLLOW ?? 0;
  const handle = await open(modulePath, constants.O_RDONLY | noFollow);
  try {
    const openedStat = await handle.stat();
    if (!openedStat.isFile() || openedStat.size < 1 || openedStat.size > MAX_BINDINGS_MODULE_BYTES) {
      throw new Error(`H3 Toolkit bindings artifact must be 1..${MAX_BINDINGS_MODULE_BYTES} bytes`);
    }
    const chunks: Buffer[] = [];
    const hash = createHash("sha256");
    let totalBytes = 0;
    while (true) {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
      if (totalBytes > MAX_BINDINGS_MODULE_BYTES) {
        throw new Error(`H3 Toolkit bindings artifact exceeds ${MAX_BINDINGS_MODULE_BYTES} bytes`);
      }
      const chunk = Buffer.from(buffer.subarray(0, bytesRead));
      hash.update(chunk);
      chunks.push(chunk);
    }
    const actualDigest = `sha256:${hash.digest("hex")}`;
    if (actualDigest !== expectedDigest) {
      throw new Error("H3 Toolkit bindings artifact digest does not match the approved deployment digest");
    }
    return Buffer.concat(chunks, totalBytes);
  } finally {
    await handle.close();
  }
}

