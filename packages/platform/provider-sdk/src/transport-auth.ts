import { timingSafeEqual } from "node:crypto";
import { ProviderProtocolError } from "./errors.js";

export function validateProviderTransportToken(value: string | undefined): string {
  if (value === undefined || Buffer.byteLength(value, "utf8") < 32) {
    throw new Error("PROVIDER_TRANSPORT_SHARED_TOKEN must contain at least 32 bytes");
  }
  return value;
}

export function createProviderTransportAuthenticator(
  sharedToken: string
): (authorization: string | readonly string[] | undefined) => void {
  const expected = Buffer.from(`Bearer ${validateProviderTransportToken(sharedToken)}`, "utf8");
  return (authorization): void => {
    const raw = typeof authorization === "string" ? authorization : authorization?.[0];
    const supplied = raw === undefined ? Buffer.alloc(0) : Buffer.from(raw, "utf8");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new ProviderProtocolError("SCOPE_DENIED", "Provider transport authentication failed");
    }
  };
}
