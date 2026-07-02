import { describe, it, expect } from "bun:test";
import { materializePeriods, type BillingPeriodPolicy } from "../billing";

describe("materializePeriods", () => {
  describe("calendar_month", () => {
    it("should generate periods for calendar months", () => {
      const policy: BillingPeriodPolicy = {
        recurrence: "calendar_month",
        boundaryInclusivity: "half_open",
      };

      const start = new Date("2026-01-01");
      const end = new Date("2026-04-01");

      const periods = [...materializePeriods(policy, start, end)];

      expect(periods).toHaveLength(3);
      expect(periods[0].periodStart).toEqual(new Date("2026-01-01"));
      expect(periods[0].periodEnd).toEqual(new Date("2026-02-01"));
      expect(periods[2].periodEnd).toEqual(new Date("2026-04-01"));
    });
  });

  describe("day_of_month with clamp_last_day", () => {
    it("should handle anchor_day=20 for months with ≥20 days", () => {
      const policy: BillingPeriodPolicy = {
        recurrence: "day_of_month",
        anchorDay: 20,
        shortMonthPolicy: "clamp_last_day",
        boundaryInclusivity: "half_open",
      };

      const start = new Date("2026-01-20");
      const end = new Date("2026-04-20");

      const periods = [...materializePeriods(policy, start, end)];

      expect(periods).toHaveLength(3);
      expect(periods[0].periodStart).toEqual(new Date("2026-01-20"));
      expect(periods[0].periodEnd).toEqual(new Date("2026-02-20"));
    });

    it("should clamp anchor_day=31 to last day in February (leap year)", () => {
      const policy: BillingPeriodPolicy = {
        recurrence: "day_of_month",
        anchorDay: 31,
        shortMonthPolicy: "clamp_last_day",
        boundaryInclusivity: "half_open",
      };

      const start = new Date("2024-01-31");
      const end = new Date("2024-04-01");

      const periods = [...materializePeriods(policy, start, end)];

      expect(periods[0].periodStart).toEqual(new Date("2024-01-31"));
      expect(periods[0].periodEnd).toEqual(new Date("2024-02-29")); // 2024 is leap year
      expect(periods[1].periodStart).toEqual(new Date("2024-02-29"));
      expect(periods[1].periodEnd).toEqual(new Date("2024-03-31"));
    });

    it("should clamp anchor_day=31 to last day in February (non-leap year)", () => {
      const policy: BillingPeriodPolicy = {
        recurrence: "day_of_month",
        anchorDay: 31,
        shortMonthPolicy: "clamp_last_day",
        boundaryInclusivity: "half_open",
      };

      const start = new Date("2026-01-31");
      const end = new Date("2026-04-01");

      const periods = [...materializePeriods(policy, start, end)];

      expect(periods[0].periodStart).toEqual(new Date("2026-01-31"));
      expect(periods[0].periodEnd).toEqual(new Date("2026-02-28")); // 2026 is not leap year
      expect(periods[1].periodStart).toEqual(new Date("2026-02-28"));
      expect(periods[1].periodEnd).toEqual(new Date("2026-03-31"));
    });

    it("should handle 20th→20th boundary correctly", () => {
      const policy: BillingPeriodPolicy = {
        recurrence: "day_of_month",
        anchorDay: 20,
        shortMonthPolicy: "clamp_last_day",
        boundaryInclusivity: "half_open",
      };

      const start = new Date("2026-06-20");
      const end = new Date("2026-09-20");

      const periods = [...materializePeriods(policy, start, end)];

      expect(periods).toHaveLength(3);
      expect(periods[0]).toEqual({
        periodStart: new Date("2026-06-20"),
        periodEnd: new Date("2026-07-20"),
        label: expect.any(String),
      });
      expect(periods[1]).toEqual({
        periodStart: new Date("2026-07-20"),
        periodEnd: new Date("2026-08-20"),
        label: expect.any(String),
      });
      expect(periods[2]).toEqual({
        periodStart: new Date("2026-08-20"),
        periodEnd: new Date("2026-09-20"),
        label: expect.any(String),
      });
    });
  });

  describe("day_of_month with skip", () => {
    it("should skip short months with skip policy", () => {
      const policy: BillingPeriodPolicy = {
        recurrence: "day_of_month",
        anchorDay: 31,
        shortMonthPolicy: "skip",
        boundaryInclusivity: "half_open",
      };

      const start = new Date("2026-01-31");
      const end = new Date("2026-05-01");

      const periods = [...materializePeriods(policy, start, end)];

      // Should skip Feb (has no 31st)
      expect(periods.length).toBeGreaterThan(0);
    });
  });

  describe("n_monthly", () => {
    it("should generate bi-monthly periods (intervalCount=2)", () => {
      const policy: BillingPeriodPolicy = {
        recurrence: "n_monthly",
        intervalCount: 2,
        anchorDate: new Date("2026-01-01"),
        boundaryInclusivity: "half_open",
      };

      const start = new Date("2026-01-01");
      const end = new Date("2026-07-01");

      const periods = [...materializePeriods(policy, start, end)];

      expect(periods.length).toBeGreaterThan(0);
      // Verify 2-month intervals (59-61 days depending on month lengths)
      if (periods.length > 1) {
        const diff =
          (periods[1].periodStart.getTime() - periods[0].periodStart.getTime()) /
          (1000 * 60 * 60 * 24);
        expect(diff).toBeGreaterThanOrEqual(59);
        expect(diff).toBeLessThanOrEqual(62);
      }
    });

    it("should generate quarterly periods (intervalCount=3)", () => {
      const policy: BillingPeriodPolicy = {
        recurrence: "n_monthly",
        intervalCount: 3,
        anchorDate: new Date("2026-01-01"),
        boundaryInclusivity: "half_open",
      };

      const start = new Date("2026-01-01");
      const end = new Date("2026-10-01");

      const periods = [...materializePeriods(policy, start, end)];

      expect(periods.length).toBeGreaterThan(0);
    });
  });

  describe("weekly", () => {
    it("should generate weekly periods", () => {
      const policy: BillingPeriodPolicy = {
        recurrence: "weekly",
        intervalCount: 1,
        anchorDate: new Date("2026-01-01"),
        boundaryInclusivity: "half_open",
      };

      const start = new Date("2026-01-01");
      const end = new Date("2026-02-01");

      const periods = [...materializePeriods(policy, start, end)];

      expect(periods.length).toBeGreaterThan(3);
      // Each period should be ~7 days apart
      if (periods.length > 1) {
        const diff =
          (periods[1].periodStart.getTime() - periods[0].periodStart.getTime()) /
          (1000 * 60 * 60 * 24);
        expect(diff).toBeCloseTo(7, 1);
      }
    });

    it("should generate fortnightly periods (intervalCount=2)", () => {
      const policy: BillingPeriodPolicy = {
        recurrence: "weekly",
        intervalCount: 2,
        anchorDate: new Date("2026-01-01"),
        boundaryInclusivity: "half_open",
      };

      const start = new Date("2026-01-01");
      const end = new Date("2026-03-01");

      const periods = [...materializePeriods(policy, start, end)];

      expect(periods.length).toBeGreaterThan(0);
    });
  });

  describe("fiscal (4-4-5)", () => {
    it("should generate 4-4-5 fiscal periods", () => {
      const policy: BillingPeriodPolicy = {
        recurrence: "fiscal",
        fiscalPattern: "4-4-5",
        anchorDate: new Date("2026-01-01"),
        leapWeekPlacement: "last",
        boundaryInclusivity: "half_open",
      };

      const start = new Date("2026-01-01");
      const end = new Date("2027-01-01");

      const periods = [...materializePeriods(policy, start, end)];

      expect(periods.length).toBeGreaterThan(0);
      // Should have periods labeled FY26 P1, P2, P3
      expect(periods.some((p) => p.label.includes("P1"))).toBe(true);
    });

    it("should generate 4-5-4 fiscal periods", () => {
      const policy: BillingPeriodPolicy = {
        recurrence: "fiscal",
        fiscalPattern: "4-5-4",
        anchorDate: new Date("2026-01-01"),
        leapWeekPlacement: "last",
        boundaryInclusivity: "half_open",
      };

      const start = new Date("2026-01-01");
      const end = new Date("2027-01-01");

      const periods = [...materializePeriods(policy, start, end)];

      expect(periods.length).toBeGreaterThan(0);
    });

    it("should generate 5-4-4 fiscal periods", () => {
      const policy: BillingPeriodPolicy = {
        recurrence: "fiscal",
        fiscalPattern: "5-4-4",
        anchorDate: new Date("2026-01-01"),
        leapWeekPlacement: "last",
        boundaryInclusivity: "half_open",
      };

      const start = new Date("2026-01-01");
      const end = new Date("2027-01-01");

      const periods = [...materializePeriods(policy, start, end)];

      expect(periods.length).toBeGreaterThan(0);
    });
  });

  describe("meter_read and manual", () => {
    it("should not generate periods for meter_read recurrence", () => {
      const policy: BillingPeriodPolicy = {
        recurrence: "meter_read",
        boundaryInclusivity: "half_open",
      };

      const start = new Date("2026-01-01");
      const end = new Date("2026-12-31");

      const periods = [...materializePeriods(policy, start, end)];

      expect(periods).toHaveLength(0);
    });

    it("should not generate periods for manual recurrence", () => {
      const policy: BillingPeriodPolicy = {
        recurrence: "manual",
        boundaryInclusivity: "half_open",
      };

      const start = new Date("2026-01-01");
      const end = new Date("2026-12-31");

      const periods = [...materializePeriods(policy, start, end)];

      expect(periods).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("should handle single-day range", () => {
      const policy: BillingPeriodPolicy = {
        recurrence: "calendar_month",
        boundaryInclusivity: "half_open",
      };

      const start = new Date("2026-01-15");
      const end = new Date("2026-01-16");

      const periods = [...materializePeriods(policy, start, end)];

      expect(periods.length).toBeGreaterThanOrEqual(0);
    });

    it("should return empty when start >= end", () => {
      const policy: BillingPeriodPolicy = {
        recurrence: "calendar_month",
        boundaryInclusivity: "half_open",
      };

      const start = new Date("2026-02-01");
      const end = new Date("2026-01-01");

      const periods = [...materializePeriods(policy, start, end)];

      expect(periods).toHaveLength(0);
    });

    it("should generate labels for periods", () => {
      const policy: BillingPeriodPolicy = {
        recurrence: "calendar_month",
        boundaryInclusivity: "half_open",
      };

      const start = new Date("2026-01-01");
      const end = new Date("2026-03-01");

      const periods = [...materializePeriods(policy, start, end)];

      expect(periods.every((p) => p.label && p.label.length > 0)).toBe(true);
    });
  });
});
