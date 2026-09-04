import { describe, expect, it } from "vitest";
import { createAirportGeoreference, geographicToLocal, localToGeographic } from "../../packages/opendrive-network-compiler/src/index.js";

describe("airport compatibility georeference", () => {
  it("maps the origin and golden oracle vectors exactly", () => {
    expect(localToGeographic([0, 0, 0])).toEqual([106.81485, 29.7195, 500]);
    expect(localToGeographic([111_320, 110_540, 10])).toEqual([107.81485, 30.7195, 510]);
    expect(geographicToLocal([107.81485, 30.7195, 510])).toEqual([111_320, 110_540, 10]);
    expect(createAirportGeoreference()).toMatchObject({ transformId: "airport-roadrunner-linear-compat-v1", accuracyClaim: "UNVERIFIED_COMPATIBILITY_TRANSFORM" });
  });

  it("round trips deterministic pseudo-random local points", () => {
    let state = 0x6d2b79f5;
    for (let index = 0; index < 1_000; index += 1) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0; const x = (state / 0xffff_ffff - 0.5) * 2_000;
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0; const y = (state / 0xffff_ffff - 0.5) * 2_000;
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0; const z = (state / 0xffff_ffff - 0.5) * 100;
      const roundTrip = geographicToLocal(localToGeographic([x, y, z]));
      expect(roundTrip[0]).toBeCloseTo(x, 8); expect(roundTrip[1]).toBeCloseTo(y, 8); expect(roundTrip[2]).toBeCloseTo(z, 12);
    }
  });

  it("rejects invalid or out-of-range coordinates", () => {
    expect(() => localToGeographic([Number.NaN, 0, 0])).toThrow("INVALID_COORDINATE");
    expect(() => localToGeographic([100_000_000, 0, 0])).toThrow("INVALID_COORDINATE");
  });
});
