import { ProviderProtocolError } from "../../../../packages/platform/provider-sdk/src/errors.js";

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

interface Circuit {
  state: CircuitState;
  failures: number;
  openedAt?: number;
  probeInFlight: boolean;
}

export class ProviderCircuitBreaker {
  readonly #circuits = new Map<string, Circuit>();

  constructor(
    readonly failureThreshold = 3,
    readonly resetAfterMs = 30_000,
    readonly now: () => number = Date.now
  ) {
    if (!Number.isInteger(failureThreshold) || failureThreshold < 1) throw new TypeError("failureThreshold must be positive");
    if (!Number.isInteger(resetAfterMs) || resetAfterMs < 1) throw new TypeError("resetAfterMs must be positive");
  }

  async execute<T>(providerId: string, action: () => Promise<T>): Promise<T> {
    const circuit = this.#circuits.get(providerId) ?? { state: "CLOSED", failures: 0, probeInFlight: false };
    this.#circuits.set(providerId, circuit);
    if (circuit.state === "OPEN") {
      if (circuit.openedAt === undefined || this.now() - circuit.openedAt < this.resetAfterMs) {
        throw new ProviderProtocolError("PROVIDER_NOT_READY", `provider circuit ${providerId} is open`, { retryable: true });
      }
      circuit.state = "HALF_OPEN";
    }
    if (circuit.state === "HALF_OPEN" && circuit.probeInFlight) {
      throw new ProviderProtocolError("PROVIDER_NOT_READY", `provider circuit ${providerId} is awaiting a probe`, { retryable: true });
    }
    circuit.probeInFlight = circuit.state === "HALF_OPEN";
    try {
      const result = await action();
      circuit.state = "CLOSED";
      circuit.failures = 0;
      delete circuit.openedAt;
      return result;
    } catch (error) {
      if (countsCircuitFailure(error)) {
        circuit.failures += 1;
        if (circuit.state === "HALF_OPEN" || circuit.failures >= this.failureThreshold) {
          circuit.state = "OPEN";
          circuit.openedAt = this.now();
        }
      }
      throw error;
    } finally {
      circuit.probeInFlight = false;
    }
  }

  state(providerId: string): Readonly<{ state: CircuitState; failures: number; openedAt?: number }> {
    const circuit = this.#circuits.get(providerId);
    if (!circuit) return { state: "CLOSED", failures: 0 };
    return circuit.openedAt === undefined
      ? { state: circuit.state, failures: circuit.failures }
      : { state: circuit.state, failures: circuit.failures, openedAt: circuit.openedAt };
  }
}

function countsCircuitFailure(error: unknown): boolean {
  if (!(error instanceof ProviderProtocolError)) return true;
  return error.retryable || error.code === "INTERNAL_PROVIDER_ERROR";
}
