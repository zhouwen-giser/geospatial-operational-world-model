import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

const gatewayUrl = process.env.GATEWAY_URL ?? "http://127.0.0.1:18080";
const runId = process.env.G08_RUN_ID ?? `g08-restart-${Date.now()}`;
const deadlineAt = new Date(Date.now() + 29_000).toISOString();
let gateway;

try {
  gateway = startGateway();
  await waitReady(gateway);
  await runValidation("initial");
  await stopGateway(gateway);
  gateway = startGateway();
  await waitReady(gateway);
  await runValidation("restart");
  process.stdout.write(`${JSON.stringify({
    result: "GROUNDING_GATEWAY_PROCESS_RESTART_PASS",
    runId,
    durableDirectReplay: true
  }, null, 2)}\n`);
} finally {
  if (gateway && gateway.exitCode === null) await stopGateway(gateway);
}

function startGateway() {
  return spawn(process.execPath, ["dist/services/gateway/world-capability-gateway/src/server.js"], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "inherit", "inherit"]
  });
}

async function waitReady(child) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    assert.equal(child.exitCode, null, "Gateway exited before becoming ready");
    const response = await fetch(`${gatewayUrl}/health/ready`).catch(() => undefined);
    if (response?.status === 200) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Gateway did not become ready within five seconds");
}

async function runValidation(mode) {
  const child = spawn(process.execPath, ["validation/scripts/grounding-gateway-e2e.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, G08_MODE: mode, G08_RUN_ID: runId, G08_DEADLINE_AT: deadlineAt },
    stdio: ["ignore", "inherit", "inherit"]
  });
  const [code] = await once(child, "exit");
  assert.equal(code, 0, `Gateway ${mode} validation failed`);
}

async function stopGateway(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    new Promise((resolve) => setTimeout(resolve, 5_000)).then(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    })
  ]);
}
