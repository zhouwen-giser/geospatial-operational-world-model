import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

export interface DatabaseIdentity {
  readonly database: string;
  readonly serverAddress: string;
  readonly serverPort: number;
  readonly systemIdentifier: string;
}

export interface AdmissionAuthorization {
  readonly mutate: boolean;
  readonly expectedFingerprint?: string;
  readonly allowDevelopmentDatabase: boolean;
  readonly expectedComposeProject?: string;
  readonly composeProject?: string;
}

const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const DISPOSABLE_DATABASE_PATTERN = /^gowm_opendrive_[a-z0-9_]{3,96}$/u;
const DEVELOPMENT_DATABASE = "gowm";
const COMPOSE_PROJECT_PATTERN = /^[a-z0-9][a-z0-9_-]{2,127}$/u;

function canonicalIdentity(identity: DatabaseIdentity): string {
  return JSON.stringify({
    database: identity.database,
    serverAddress: identity.serverAddress,
    serverPort: identity.serverPort,
    systemIdentifier: identity.systemIdentifier
  });
}

export function databaseFingerprint(identity: DatabaseIdentity): string {
  return `sha256:${createHash("sha256").update(canonicalIdentity(identity)).digest("hex")}`;
}

export function readAdmissionAuthorization(environment: NodeJS.ProcessEnv): AdmissionAuthorization {
  const mutate = environment.GOWM_OPENDRIVE_ALLOW_DB_MUTATION === "YES";
  const allowDevelopmentDatabase = environment.GOWM_OPENDRIVE_ALLOW_DEVELOPMENT_DATABASE === "YES";
  const expectedFingerprint = environment.GOWM_OPENDRIVE_EXPECTED_DB_FINGERPRINT;
  const expectedComposeProject = environment.GOWM_OPENDRIVE_EXPECTED_COMPOSE_PROJECT;
  const composeProject = environment.COMPOSE_PROJECT_NAME;
  if (expectedFingerprint !== undefined && !FINGERPRINT_PATTERN.test(expectedFingerprint)) {
    throw new Error("GOWM_OPENDRIVE_EXPECTED_DB_FINGERPRINT must be a sha256 digest");
  }
  for (const [name, value] of [
    ["GOWM_OPENDRIVE_EXPECTED_COMPOSE_PROJECT", expectedComposeProject],
    ["COMPOSE_PROJECT_NAME", composeProject]
  ] as const) {
    if (value !== undefined && !COMPOSE_PROJECT_PATTERN.test(value)) {
      throw new Error(`${name} must be a valid Compose project identity`);
    }
  }
  return {
    mutate,
    allowDevelopmentDatabase,
    ...(expectedFingerprint === undefined ? {} : { expectedFingerprint }),
    ...(expectedComposeProject === undefined ? {} : { expectedComposeProject }),
    ...(composeProject === undefined ? {} : { composeProject })
  };
}

export function assertMutationAuthorized(
  authorization: AdmissionAuthorization,
  identity: DatabaseIdentity
): string {
  if (!authorization.mutate) {
    throw new Error("database mutation is disabled; set GOWM_OPENDRIVE_ALLOW_DB_MUTATION=YES only for an authorized acceptance or development database");
  }
  if (!authorization.expectedFingerprint) {
    throw new Error("GOWM_OPENDRIVE_EXPECTED_DB_FINGERPRINT is required for database mutation");
  }
  const observed = databaseFingerprint(identity);
  if (authorization.expectedFingerprint !== observed) {
    throw new Error("database instance fingerprint does not match GOWM_OPENDRIVE_EXPECTED_DB_FINGERPRINT");
  }
  if (identity.database === DEVELOPMENT_DATABASE) {
    if (!authorization.allowDevelopmentDatabase) {
      throw new Error("development database mutation is disabled; set GOWM_OPENDRIVE_ALLOW_DEVELOPMENT_DATABASE=YES explicitly");
    }
    if (!authorization.expectedComposeProject || !authorization.composeProject ||
        authorization.expectedComposeProject !== authorization.composeProject) {
      throw new Error("development database Compose project identity is missing or does not match");
    }
  } else if (!DISPOSABLE_DATABASE_PATTERN.test(identity.database)) {
    throw new Error("database name must be a disposable gowm_opendrive_* database or the explicitly authorized gowm development database");
  }
  return observed;
}

export async function inspectDatabaseIdentity(client: Pick<PoolClient, "query">): Promise<DatabaseIdentity> {
  const result = await client.query<{
    database_name: string;
    server_address: string | null;
    server_port: number | null;
    system_identifier: string;
  }>(`SELECT current_database() AS database_name,
             COALESCE(inet_server_addr()::text, 'local-socket') AS server_address,
             COALESCE(inet_server_port(), 0) AS server_port,
             system_identifier::text
      FROM pg_control_system()`);
  const row = result.rows[0];
  if (!row || !row.database_name || !row.server_address || !row.system_identifier ||
      row.server_port === null || !Number.isInteger(row.server_port) || row.server_port < 0) {
    throw new Error("database identity is unavailable; mutation is denied");
  }
  return {
    database: row.database_name,
    serverAddress: row.server_address,
    serverPort: row.server_port,
    systemIdentifier: row.system_identifier
  };
}
