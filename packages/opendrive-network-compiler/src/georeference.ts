import { canonicalJson, sha256 } from "./canonical.js";

export const ORACLE_ARTIFACT_HASH = "sha256:be045dba9c2bbee109439e0280a28b563b50f1a3ceee4c8783ce34fed8d1429d";

const BASE_CONFIG = {
  schemaVersion: "1.0.0",
  transformId: "airport-roadrunner-linear-compat-v1",
  method: "LOCAL_LINEAR_DEGREES_COMPAT_V1",
  sourceFrame: "ROADRUNNER_LOCAL_X_EAST_Y_NORTH_Z_UP",
  targetCrs: "EPSG:4326",
  origin: { longitude: 106.81485, latitude: 29.7195, altitudeM: 500 },
  metresPerDegreeLongitude: 111_320,
  metresPerDegreeLatitude: 110_540,
  axisMapping: { x: "EAST", y: "NORTH", z: "UP" },
  oracleArtifactHash: ORACLE_ARTIFACT_HASH,
  accuracyClaim: "UNVERIFIED_COMPATIBILITY_TRANSFORM"
} as const;

export type GeoreferenceConfig = typeof BASE_CONFIG & { contentHash: string };
export type LocalCoordinate = readonly [x: number, y: number, z: number];
export type GeographicCoordinate = readonly [longitude: number, latitude: number, altitudeM: number];

export function createAirportGeoreference(): GeoreferenceConfig {
  return { ...BASE_CONFIG, contentHash: sha256(canonicalJson(BASE_CONFIG)) };
}

function finite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new Error(`INVALID_COORDINATE: ${name} must be finite`);
}

export function localToGeographic(local: LocalCoordinate, config = createAirportGeoreference()): GeographicCoordinate {
  const [x, y, z] = local;
  finite(x, "x"); finite(y, "y"); finite(z, "z");
  const longitude = config.origin.longitude + x / config.metresPerDegreeLongitude;
  const latitude = config.origin.latitude + y / config.metresPerDegreeLatitude;
  const altitudeM = config.origin.altitudeM + z;
  if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
    throw new Error("INVALID_COORDINATE: transformed longitude/latitude is outside EPSG:4326 bounds");
  }
  finite(longitude, "longitude"); finite(latitude, "latitude"); finite(altitudeM, "altitudeM");
  return [longitude, latitude, altitudeM];
}

export function geographicToLocal(point: GeographicCoordinate, config = createAirportGeoreference()): LocalCoordinate {
  const [longitude, latitude, altitudeM] = point;
  finite(longitude, "longitude"); finite(latitude, "latitude"); finite(altitudeM, "altitudeM");
  if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
    throw new Error("INVALID_COORDINATE: longitude/latitude is outside EPSG:4326 bounds");
  }
  return [
    (longitude - config.origin.longitude) * config.metresPerDegreeLongitude,
    (latitude - config.origin.latitude) * config.metresPerDegreeLatitude,
    altitudeM - config.origin.altitudeM
  ];
}
