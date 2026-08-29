import { createPublicKey, verify as verifySignature } from "node:crypto";
import type { FastifyRequest } from "fastify";
import {
  validateContract,
  type DelegationTokenClaims
} from "../../../../packages/platform/contract-runtime/src/index.js";
import { ProviderProtocolError, sha256 } from "../../../../packages/platform/provider-sdk/src/index.js";
import type { GatewayServerConfig } from "./config.js";
import { principalContextHash } from "./principal-context.js";
import type { GatewayPrincipal } from "./types.js";

const CLOCK_SKEW_SECONDS = 5;

export interface DelegationVerificationContext {
  servicePrincipalRef: string;
  requestId: string;
  allowedDataScopes: readonly string[];
  allowedDatasetScopes: readonly string[];
  registeredOperations: readonly string[];
  allowExperimental: boolean;
}

export interface DelegationVerifier {
  verify(compactJws: string, context: DelegationVerificationContext): GatewayPrincipal;
}

export class SignedDelegationVerifier implements DelegationVerifier {
  readonly #publicKey: ReturnType<typeof createPublicKey>;

  constructor(private readonly options: {
    issuer: string;
    audience: string;
    publicKey: string;
    maximumTtlSeconds?: number;
    now?: () => Date;
  }) {
    this.#publicKey = createPublicKey(options.publicKey);
  }

  verify(compactJws: string, context: DelegationVerificationContext): GatewayPrincipal {
    const segments = compactJws.split(".");
    if (segments.length !== 3 || segments.some((segment) => segment.length === 0)) {
      throw denied("delegation token must be a compact JWS");
    }
    const [encodedHeader, encodedPayload, encodedSignature] = segments as [string, string, string];
    const header = parseSegment(encodedHeader, "delegation JWS header");
    if (header.alg !== "RS256" || (header.typ !== undefined && header.typ !== "JWT")) {
      throw denied("delegation JWS algorithm is not allowed");
    }
    if (!verifySignature(
      "RSA-SHA256",
      Buffer.from(`${encodedHeader}.${encodedPayload}`, "ascii"),
      this.#publicKey,
      Buffer.from(encodedSignature, "base64url")
    )) {
      throw denied("delegation JWS signature is invalid");
    }

    const claims = parseSegment(encodedPayload, "delegation JWS claims") as unknown;
    const validation = validateContract("urn:gowm:v0.6.3:delegation-token-claims", claims);
    if (!validation.valid) throw denied("delegation claims violate the contract");
    const token = claims as DelegationTokenClaims;
    const now = Math.floor((this.options.now?.() ?? new Date()).getTime() / 1_000);
    const maximumTtl = this.options.maximumTtlSeconds ?? 300;
    if (token.iss !== this.options.issuer || token.aud !== this.options.audience) throw denied("delegation issuer or audience is invalid");
    if (token.sub !== context.servicePrincipalRef) throw denied("delegation subject differs from the authenticated service");
    if (token.requestId !== context.requestId) throw denied("delegation token is bound to another request");
    if (token.iat > now + CLOCK_SKEW_SECONDS || token.nbf > now + CLOCK_SKEW_SECONDS || token.exp <= now - CLOCK_SKEW_SECONDS) {
      throw denied("delegation token is outside its valid time window");
    }
    if (token.exp <= token.iat || token.exp - token.iat > maximumTtl) throw denied("delegation token TTL exceeds policy");

    const effectiveDataScopes = intersection(token.dataScopes, context.allowedDataScopes);
    const effectiveDatasetScopes = intersection(token.datasetScopes, context.allowedDatasetScopes);
    if (context.allowedDataScopes.length > 0 && effectiveDataScopes.length === 0) throw denied("delegation grants no allowed data scope");
    if (context.allowedDatasetScopes.length > 0 && effectiveDatasetScopes.length === 0) throw denied("delegation grants no allowed dataset scope");
    const allowedOperations = intersection(token.allowedOperations, context.registeredOperations);
    if (allowedOperations.length === 0) throw denied("delegation grants no registered operation");

    const principal: GatewayPrincipal = {
      mode: "SIGNED_DELEGATION_V1",
      principalRef: context.servicePrincipalRef,
      servicePrincipalRef: context.servicePrincipalRef,
      actorRef: token.act.sub,
      authenticationMethod: "SERVICE_BEARER+JWS_DELEGATION",
      authenticatedAt: new Date(now * 1_000).toISOString(),
      effectiveDataScopes,
      effectiveDatasetScopes,
      ...(effectiveDataScopes[0] === undefined ? {} : { dataScopeClaim: effectiveDataScopes[0] }),
      ...(effectiveDatasetScopes[0] === undefined ? {} : { datasetScopeClaim: effectiveDatasetScopes[0] }),
      allowedOperations,
      delegationJtiHash: sha256(token.jti),
      allowExperimental: context.allowExperimental
    };
    principal.authorizationContextHash = principalContextHash(principal);
    return principal;
  }
}

export function createGatewayAuthenticator(
  config: GatewayServerConfig,
  registeredOperations: () => string[]
): (request: FastifyRequest) => Promise<GatewayPrincipal> {
  const authenticateService = staticBearer(config);
  if (config.authenticationMode === "STATIC_SERVICE") return authenticateService;
  const verifier = new SignedDelegationVerifier({
    issuer: config.delegationIssuer!,
    audience: config.delegationAudience!,
    publicKey: config.delegationPublicKey!,
    maximumTtlSeconds: config.delegationMaximumTtlSeconds
  });
  return async (request) => {
    const authenticatedService = await authenticateService(request);
    const service = {
      ...authenticatedService,
      allowedDataScopes: config.allowedDataScopes ?? (
        authenticatedService.dataScopeClaim === undefined ? [] : [authenticatedService.dataScopeClaim]
      )
    };
    const raw = request.headers["x-gowm-delegation"];
    if (typeof raw !== "string" || !raw.trim()) throw denied("signed delegation header is required");
    return verifier.verify(raw, {
      servicePrincipalRef: service.principalRef,
      requestId: requestIdentity(request),
      allowedDataScopes: service.allowedDataScopes,
      allowedDatasetScopes: service.datasetScopeClaim === undefined ? [] : [service.datasetScopeClaim],
      registeredOperations: registeredOperations(),
      allowExperimental: service.allowExperimental ?? false
    });
  };
}

export function staticBearer(
  config: Pick<GatewayServerConfig, "sharedToken" | "principalRef" | "dataScopeClaim" | "datasetScopeClaim" | "allowExperimental">
): (request: FastifyRequest) => Promise<GatewayPrincipal> {
  const expected = Buffer.from(`Bearer ${config.sharedToken}`, "utf8");
  return async (request) => {
    const supplied = typeof request.headers.authorization === "string"
      ? Buffer.from(request.headers.authorization, "utf8")
      : Buffer.alloc(0);
    if (supplied.length !== expected.length || !timingSafeEqualLocal(supplied, expected)) {
      throw denied("Gateway transport authentication failed");
    }
    return {
      mode: "STATIC_SERVICE",
      principalRef: config.principalRef,
      servicePrincipalRef: config.principalRef,
      actorRef: config.principalRef,
      authenticationMethod: "COMPOSE_SHARED_TOKEN",
      authenticatedAt: new Date().toISOString(),
      ...(config.dataScopeClaim === undefined ? {} : {
        dataScopeClaim: config.dataScopeClaim,
        effectiveDataScopes: [config.dataScopeClaim]
      }),
      ...(config.datasetScopeClaim === undefined ? {} : {
        datasetScopeClaim: config.datasetScopeClaim,
        effectiveDatasetScopes: [config.datasetScopeClaim]
      }),
      allowExperimental: config.allowExperimental
    };
  };
}

function requestIdentity(request: FastifyRequest): string {
  const body = request.body;
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    const requestId = (body as Record<string, unknown>).requestId;
    if (typeof requestId === "string" && requestId.length > 0) return requestId;
  }
  return String(request.id);
}

function parseSegment(segment: string, name: string): Record<string, unknown> {
  try {
    const value = JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError();
    return value as Record<string, unknown>;
  } catch {
    throw denied(`${name} is invalid`);
  }
}

function intersection(left: readonly string[], right: readonly string[]): string[] {
  const allowed = new Set(right);
  return [...new Set(left.filter((value) => allowed.has(value)))].sort();
}

function denied(message: string): ProviderProtocolError {
  return new ProviderProtocolError("SCOPE_DENIED", message, { retryable: false });
}

function timingSafeEqualLocal(left: Buffer, right: Buffer): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}
