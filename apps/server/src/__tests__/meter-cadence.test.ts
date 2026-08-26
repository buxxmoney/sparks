import { describe, expect, it } from "bun:test";
import {
  METER_DEGRADED_WITHIN_MINUTES,
  METER_ONLINE_WITHIN_MINUTES,
  METER_REPORT_INTERVAL_MINUTES,
  meterStatusFromAge,
} from "../meter-cadence";

const min = (m: number) => m * 60_000;

describe("meterStatusFromAge", () => {
  // The regression this file exists for: the gateway batches its 60s samples and
  // uploads them every 30 minutes, so a healthy meter's newest reading is routinely
  // ~29 minutes old right before the next batch lands. The old 10-minute "online"
  // window called that degraded, and the dashboard showed the whole fleet as
  // degraded most of the time.
  it("keeps a meter online across a full upload period", () => {
    expect(meterStatusFromAge(min(0))).toBe("online");
    expect(meterStatusFromAge(min(METER_REPORT_INTERVAL_MINUTES - 1))).toBe("online");
    expect(meterStatusFromAge(min(METER_REPORT_INTERVAL_MINUTES))).toBe("online");
  });

  it("degrades only after a missed upload window", () => {
    expect(meterStatusFromAge(min(METER_ONLINE_WITHIN_MINUTES))).toBe("online");
    expect(meterStatusFromAge(min(METER_ONLINE_WITHIN_MINUTES) + 1)).toBe("degraded");
    expect(meterStatusFromAge(min(METER_DEGRADED_WITHIN_MINUTES))).toBe("degraded");
  });

  it("goes offline after two missed upload windows", () => {
    expect(meterStatusFromAge(min(METER_DEGRADED_WITHIN_MINUTES) + 1)).toBe("offline");
    expect(meterStatusFromAge(Number.POSITIVE_INFINITY)).toBe("offline");
  });

  it("orders its thresholds", () => {
    expect(METER_ONLINE_WITHIN_MINUTES).toBeGreaterThan(METER_REPORT_INTERVAL_MINUTES);
    expect(METER_DEGRADED_WITHIN_MINUTES).toBeGreaterThan(METER_ONLINE_WITHIN_MINUTES);
  });
});
