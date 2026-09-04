import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import { loadUgvIngestConfig } from "../../services/ugv-mqtt-ingest/src/config.js";

describe("UGV MQTT ingest configuration",() => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL","postgresql://test:test@postgres:5432/test");
    vi.stubEnv("UGV_MQTT_URL","mqtt://broker:1883");
    vi.stubEnv("UGV_WORLD_EPOCH","airport-run-test");
    vi.stubEnv("UGV_TRACKER_SESSION_KEY","airport-run-test:ugv");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("loads the fixed safe defaults",async () => {
    const config = await loadUgvIngestConfig();
    expect(config).toMatchObject({ clientId: "gowm-ugv-ingest-airport-01",originKind: "SIMULATION",
      analysisSpaceKey: "airport-utm48n",analysisSrid: 32648,receiveMaximum: 1,
      worldEpoch: "airport-run-test",trackerSessionKey: "airport-run-test:ugv" });
  });

  it("rejects embedded broker credentials and unsafe credential paths",async () => {
    vi.stubEnv("UGV_MQTT_URL","mqtt://user:secret@broker:1883");
    await expect(loadUgvIngestConfig()).rejects.toThrow(/must not embed credentials/u);
    vi.stubEnv("UGV_MQTT_URL","mqtt://broker:1883");
    vi.stubEnv("UGV_MQTT_PASSWORD_FILE","relative/password");
    await expect(loadUgvIngestConfig()).rejects.toThrow(/absolute path/u);
  });

  it("rejects unstable or contract-breaking values",async () => {
    vi.stubEnv("UGV_MQTT_CLIENT_ID","contains whitespace");
    await expect(loadUgvIngestConfig()).rejects.toThrow(/stable literal/u);
    vi.stubEnv("UGV_MQTT_CLIENT_ID","stable-id");
    vi.stubEnv("UGV_MQTT_RECEIVE_MAXIMUM","65536");
    await expect(loadUgvIngestConfig()).rejects.toThrow(/at most 65535/u);
    vi.stubEnv("UGV_MQTT_RECEIVE_MAXIMUM","1");
    vi.stubEnv("UGV_ANALYSIS_SRID","32650");
    await expect(loadUgvIngestConfig()).rejects.toThrow(/EPSG:32648/u);
    vi.stubEnv("UGV_ANALYSIS_SRID","32648");
    vi.stubEnv("UGV_WORLD_EPOCH","");
    await expect(loadUgvIngestConfig()).rejects.toThrow(/UGV_WORLD_EPOCH is required/u);
  });
});
