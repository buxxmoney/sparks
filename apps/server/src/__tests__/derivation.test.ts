import { describe, expect, it } from "bun:test";
import { mapRawPayloadToReading } from "../derivation";

describe("mapRawPayloadToReading", () => {
  it("maps the device payload to structured readings with unit conversion", () => {
    const payload = {
      readings: {
        energy_import_kwh: 125678.5,
        energy_import_kvarh: 31245.80078125,
        energy_kvah: 128567.8984375,
        power_total: 10412.7001953125, // WATTS
        va_total: 10794.099609375, // VA
        var_total: 2487.5,
      },
      timestamp: "2026-07-07T15:07:56.123656+00:00",
      units: { energy_import_kwh: "kWh", power_total: "W", va_total: "VA" },
    };
    const d = mapRawPayloadToReading(payload);
    expect(d.activeEnergyKwh).toBe("125678.500"); // cumulative register, verbatim
    expect(d.reactiveEnergyKvarh).toBe("31245.801");
    expect(d.apparentEnergyKvah).toBe("128567.898");
    expect(d.totalPowerKw).toBe("10.413"); // 10412.70 W → kW
    expect(d.totalApparentKva).toBe("10.794"); // 10794.10 VA → kVA
    expect(d.powerFactor).toBe("0.9647"); // |kW / kVA|
  });

  it("falls back to summing per-phase power/va when totals are absent", () => {
    const d = mapRawPayloadToReading({
      readings: { power_l1: 1000, power_l2: 1000, power_l3: 1000, va_l1: 1200, va_l2: 1200, va_l3: 1200 },
      timestamp: "2026-07-07T15:00:00+00:00",
    });
    expect(d.totalPowerKw).toBe("3.000");
    expect(d.totalApparentKva).toBe("3.600");
  });

  it("returns nulls for a payload with no usable fields", () => {
    const d = mapRawPayloadToReading({ readings: {}, timestamp: "2026-07-07T15:00:00+00:00" });
    expect(d.activeEnergyKwh).toBeNull();
    expect(d.totalPowerKw).toBeNull();
    expect(d.powerFactor).toBeNull();
  });

  it("clamps power factor to at most 1", () => {
    // Slightly noisy kW just above kVA → PF must not exceed 1.
    const d = mapRawPayloadToReading({
      readings: { power_total: 5001, va_total: 5000 },
      timestamp: "2026-07-07T15:00:00+00:00",
    });
    expect(Number(d.powerFactor)).toBeLessThanOrEqual(1);
  });
});
