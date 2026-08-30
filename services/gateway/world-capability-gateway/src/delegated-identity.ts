import { createPublicKey, verify as verifySignature } from "node:crypto";
import type { FastifyRequest } from "fastify";
import {
  compareUnicodeCodePoints,
  validateContract,
  type GowmV071DelegationTokenClaims
} from "../../../../packages/platform/contract-runtime/src/index.js";
import { ProviderProtocolError, sha256 } from "../../../../packages/platform/provider-sdk/src/index.js";
import type { GatewayServerConfig, SignedDelegationGatewayConfig } from "./config.js";
import { principalContextHash } from "./principal-context.js";
import type { GatewayPrincipal, SignedDelegationGatewayPrincipal } from "./types.js";

const CLOCK_SKEW_SECONDS = 5;

export interface DelegationVerificationContext {
  servicePrincipalRef: string;
  requestId: string;
  allowedDataScopes: readonly [string];
  allowedDatasetScopes: readonly [] | readonly [string];
  registeredOperations: readonly string[];
  allowExperimental: boolean;
}

export interface DelegationVerifier {
  verify(compactJws: string, context: DelegationVerificationContext): SignedDelegationGatewayPrincipal;
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

  verify(compactJws: string, context: DelegationVerificationContext): SignedDelegationGatewayPrincipal {
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
    assertSingleScopeClaims(claims);
    const validation = validateContract("urn:gowm:v0.7.1:delegation-token-claims", claims);
    if (!validation.valid) throw denied("delegation claims violate the contract");
    const token = claims as GowmV071DelegationTokenClaims;
    const now = Math.floor((this.options.now?.() ?? new Date()).getTime() / 1_000);
    const maximumTtl = this.options.maximumTtlSeconds ?? 300;
    if (token.iss !== this.options.issuer || token.aud !== this.options.audience) throw denied("delegation issuer or audience is invalid");
    if (token.sub !== context.servicePrincipalRef) throw denied("delegation subject differs from the authenticated service");
    if (token.requestId !== context.requestId) throw denied("delegation token is bound to another request");
    if (token.iat > now + CLOCK_SKEW_SECONDS || token.nbf > now + CLOCK_SKEW_SECONDS || token.exp <= now - CLOCK_SKEW_SECONDS) {
      throw denied("delegation token is outside its valid time window");
    }
    if (token.exp <= token.iat || token.exp - token.iat > maximumTtl) throw denied("delegation token TTL exceeds policy");

    assertVerificationScopeContext(context);
    const tokenDataScope = token.dataScopes[0];
    if (tokenDataScope === undefined || tokenDataScope !== context.allowedDataScopes[0]) {
      throw denied("delegation grants no allowed data scope");
    }
    const tokenDatasetScope = token.datasetScopes[0];
    if (tokenDatasetScope !== undefined && tokenDatasetScope !== context.allowedDatasetScopes[0]) {
      throw denied("delegation grants no allowed dataset scope");
    }
    const effectiveDatasetScopes = tokenDatasetScope === undefined ? [] as const : [tokenDatasetScope] as const;
    const allowedOperations = intersection(token.allowedOperations, context.registeredOperations);
    if (allowedOperations.length === 0) throw denied("delegation grants no registered operation");

    const principal: SignedDelegationGatewayPrincipal = {
      mode: "SIGNED_DELEGATION_V1",
      principalRef: context.servicePrincipalRef,
      servicePrincipalRef: context.servicePrincipalRef,
      actorRef: token.act.sub,
      authenticationMethod: "SERVICE_BEARER+JWS_DELEGATION",
      authenticatedAt: new Date(now * 1_000).toISOString(),
      effectiveDataScopes: [tokenDataScope] as const,
      effectiveDatasetScopes,
      dataScopeClaim: tokenDataScope,
      ...(tokenDatasetScope === undefined ? {} : { datasetScopeClaim: tokenDatasetScope }),
      allowedOperations,
      delegationJtiHash: sha256(token.jti),
      allowExperimental: context.allowExperimental,
      authorizationContextHash: "" as `sha256:${string}`
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
  assertSignedDelegationConfig(config);
  const verifier = new SignedDelegationVerifier({
    issuer: config.delegationIssuer,
    audience: config.delegationAudience,
    publicKey: config.delegationPublicKey,
    maximumTtlSeconds: config.delegationMaximumTtlSeconds
  });
  return async (request) => {
    const service = await authenticateService(request);
    const raw = request.headers["x-gowm-delegation"];
    if (typeof raw !== "string" || !raw.trim()) throw denied("signed delegation header is required");
    return verifier.verify(raw, {
      servicePrincipalRef: service.principalRef,
      requestId: requestIdentity(request),
      allowedDataScopes: [config.dataScopeClaim],
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
        effectiveDataScopes: [config.dataScopeClaim] as const
      }),
      ...(config.datasetScopeClaim === undefined ? {} : {
        datasetScopeClaim: config.datasetScopeClaim,
        effectiveDatasetScopes: [config.datasetScopeClaim] as const
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
  return [...new Set(left.filter((value) => allowed.has(value)))].sort(compareUnicodeCodePoints);
}

function assertVerificationScopeContext(context: DelegationVerificationContext): void {
  if (context.allowedDataScopes.length !== 1 || context.allowedDatasetScopes.length > 1) {
    throw denied("delegation verifier scope configuration is not singleton", "MULTI_SCOPE_UNSUPPORTED");
  }
  if (
    context.allowedDataScopes[0].trim().length === 0
    || context.allowedDatasetScopes.some((value) => value.trim().length === 0)
  ) {
    throw denied("delegation verifier scope configuration is empty");
  }
}

function assertSignedDelegationConfig(config: GatewayServerConfig): asserts config is SignedDelegationGatewayConfig {
  if (
    !config.dataScopeClaim
    || !config.delegationIssuer
    || !config.delegationAudience
    || !config.delegationPublicKey
  ) {
    throw new Error("SIGNED_DELEGATION_V1 configuration is incomplete");
  }
}

function assertSingleScopeClaims(claims: unknown): void {
  if (claims === null || typeof claims !== "object" || Array.isArray(claims)) return;
  const value = claims as Record<string, unknown>;
  if ((Array.isArray(value.dataScopes) && value.dataScopes.length > 1) ||
      (Array.isArray(value.datasetScopes) && value.datasetScopes.length > 1)) {
    throw denied("delegation token contains multiple scopes", "MULTI_SCOPE_UNSUPPORTED");
  }
}

function denied(message: string, reason?: string): ProviderProtocolError {
  return new ProviderProtocolError("SCOPE_DENIED", message, {
    retryable: false,
    ...(reason === undefined ? {} : { details: { reason } })
  });
}

function timingSafeEqualLocal(left: Buffer, right: Buffer): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}
