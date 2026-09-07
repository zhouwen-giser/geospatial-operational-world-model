import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const script = resolve(process.cwd(), "scripts/dev-deploy.sh");

function probeAddress(bindAddress: string): string {
  return execFileSync(
    "bash",
    ["-c", 'source "$1"; host_probe_address "$2"', "dev-deploy-probe-test", script, bindAddress],
    { encoding: "utf8" }
  ).trim();
}

describe("development deployment host probes", () => {
  it.each([
    ["0.0.0.0", "127.0.0.1"],
    ["::", "[::1]"],
    ["192.0.2.25", "192.0.2.25"],
    ["2001:db8::25", "[2001:db8::25]"],
    ["[2001:db8::26]", "[2001:db8::26]"]
  ])("maps DEV_BIND_ADDRESS %s to %s", (bindAddress, expected) => {
    expect(probeAddress(bindAddress)).toBe(expected);
  });
});
