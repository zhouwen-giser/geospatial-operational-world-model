import { describe, expect, it } from "vitest";
import {
  assertMutationAuthorized,
  databaseFingerprint,
  readAdmissionAuthorization,
  type DatabaseIdentity
} from "../../scripts/opendrive/admission-safety.js";
import { catalogGeoJson } from "../../scripts/opendrive/admit.js";

const identity: DatabaseIdentity = {
  database: "gowm_opendrive_acceptance_01",
  serverAddress: "172.28.0.2",
  serverPort: 5432,
  systemIdentifier: "7613372468944110021"
};

describe("OpenDRIVE admission mutation guard", () => {
  it("defaults to dry-run and denies mutation", () => {
    const authorization = readAdmissionAuthorization({});
    expect(authorization).toEqual({ mutate: false, allowDevelopmentDatabase: false });
    expect(() => assertMutationAuthorized(authorization, identity)).toThrow(/mutation is disabled/u);
  });

  it("requires both a disposable database name and the exact instance fingerprint", () => {
    const expectedFingerprint = databaseFingerprint(identity);
    expect(assertMutationAuthorized({ mutate: true, allowDevelopmentDatabase: false, expectedFingerprint }, identity)).toBe(expectedFingerprint);
    const other = { ...identity, database: "postgres" };
    expect(() => assertMutationAuthorized({
      mutate: true,
      allowDevelopmentDatabase: true,
      expectedFingerprint: databaseFingerprint(other),
      expectedComposeProject: "gowm-dev-20260904",
      composeProject: "gowm-dev-20260904"
    }, other)).toThrow(/database name/u);
    expect(() => assertMutationAuthorized({ mutate: true, allowDevelopmentDatabase: false, expectedFingerprint }, {
      ...identity,
      database: "gowm"
    })).toThrow(/fingerprint/u);
    expect(() => assertMutationAuthorized({ mutate: true, allowDevelopmentDatabase: false, expectedFingerprint: `sha256:${"0".repeat(64)}` }, identity))
      .toThrow(/does not match/u);
  });

  it("allows the fixed gowm development database only through all explicit gates", () => {
    const development = { ...identity, database: "gowm" };
    const expectedFingerprint = databaseFingerprint(development);
    const base = { mutate: true, expectedFingerprint, allowDevelopmentDatabase: false };
    expect(() => assertMutationAuthorized(base, development)).toThrow(/development database mutation is disabled/u);
    expect(() => assertMutationAuthorized({
      ...base,
      allowDevelopmentDatabase: true,
      expectedComposeProject: "gowm-dev-20260904",
      composeProject: "wrong-project"
    }, development)).toThrow(/project identity/u);
    expect(assertMutationAuthorized({
      ...base,
      allowDevelopmentDatabase: true,
      expectedComposeProject: "gowm-dev-20260904",
      composeProject: "gowm-dev-20260904"
    }, development)).toBe(expectedFingerprint);
  });

  it("rejects malformed configured fingerprints before connecting", () => {
    expect(() => readAdmissionAuthorization({
      GOWM_OPENDRIVE_ALLOW_DB_MUTATION: "YES",
      GOWM_OPENDRIVE_EXPECTED_DB_FINGERPRINT: "not-a-hash"
    })).toThrow(/sha256 digest/u);
    expect(() => readAdmissionAuthorization({ COMPOSE_PROJECT_NAME: "INVALID SPACE" }))
      .toThrow(/Compose project identity/u);
  });

  it("projects compiler LineStringZ coordinates onto the Catalog 2D boundary", () => {
    expect(JSON.parse(catalogGeoJson({ coordinates: [
      [106.8, 29.7, 500],
      [106.9, 29.8, 501]
    ] }))).toEqual({
      type: "LineString",
      coordinates: [[106.8, 29.7], [106.9, 29.8]]
    });
  });
});
