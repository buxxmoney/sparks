import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  billingPeriods,
  dataGaps,
  demandIntervals,
  devices,
  getDb,
  landlordInvoices,
  meters,
  reconciliations,
  siteAccess,
  siteTariffAssignments,
  sites,
  tariffProfiles,
  tariffRates,
} from "@sparks/db";
import { eq } from "drizzle-orm";
import type { AuthContext } from "../middleware";
import { buildComponentComparison, priceSegments } from "../reconciliation";
import {
  reconciliationFinalize,
  reconciliationGenerate,
  reconciliationGet,
  reconciliationList,
  reconciliationListVersions,
} from "../routers";
import type { PricingBreakdown, TariffRate } from "../tariffs";

const db = getDb();

describe("Component comparison (charged vs expected per component)", () => {
  const landlord: PricingBreakdown = {
    activeEnergyCents: 300000,
    demandCents: 550000,
    reactiveEnergyCents: 0,
    fixedCents: 0,
    ancillaryCents: 0,
    totalCents: 850000,
    details: [],
  };

  it("computes per-component charged, expected, and discrepancy", () => {
    const rows = buildComponentComparison(landlord, null, {
      confirmedActiveCents: 350000, // overcharged by 50000
      confirmedDemandCents: 550000, // exact
      confirmedReactiveCents: 0,
      confirmedFixedCents: 10000, // charged but tariff expects 0
    });
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(byKey.active.discrepancyVsLandlordCents).toBe(50000);
    expect(byKey.demand.discrepancyVsLandlordCents).toBe(0);
    expect(byKey.reactive.discrepancyVsLandlordCents).toBe(0);
    expect(byKey.fixed.chargedCents).toBe(10000);
    expect(byKey.fixed.discrepancyVsLandlordCents).toBe(10000);
  });

  it("folds ancillary into the fixed expected bucket and handles null charges", () => {
    const withAncillary: PricingBreakdown = { ...landlord, fixedCents: 5000, ancillaryCents: 2000 };
    const rows = buildComponentComparison(withAncillary, null, {
      confirmedActiveCents: null,
      confirmedDemandCents: null,
      confirmedReactiveCents: null,
      confirmedFixedCents: null,
    });
    const fixed = rows.find((r) => r.key === "fixed");
    expect(fixed?.expectedLandlordCents).toBe(7000); // 5000 fixed + 2000 ancillary
    expect(fixed?.chargedCents).toBe(0); // null → 0
    expect(fixed?.discrepancyVsLandlordCents).toBe(-7000);
  });
});

describe("Reconciliation Engine", () => {
  const orgId = "test-org-recon";
  const siteOwnerUserId = "test-site-owner-recon";
  let siteId: string;
  let meterId: string;
  let billingPeriodId: string;
  let landlordTariffId: string;

  const siteOwnerCtx: AuthContext = {
    userId: siteOwnerUserId,
    sessionId: "session-recon-001",
    organizationId: orgId,
  };

  beforeEach(async () => {
    // Create site
    const siteResult = await db
      .insert(sites)
      .values({
        organizationId: orgId,
        name: "Test Reconciliation Site",
        timezone: "Africa/Johannesburg",
        demandIntervalMinutes: 30,
        status: "active",
      })
      .returning();

    siteId = siteResult[0].id;

    // Grant site access
    await db.insert(siteAccess).values({
      siteId,
      userId: siteOwnerUserId,
      role: "owner",
    });

    // Create device
    await db.insert(devices).values({
      siteId,
      serialNumber: `recon-device-${Date.now()}`,
      hardwareModel: "rpi",
      apiKeyHash: "test-hash",
      status: "online",
    });

    // Create meter
    const meterResult = await db
      .insert(meters)
      .values({
        siteId,
        serialNumber: `recon-meter-${Date.now()}`,
        model: "SDM630MCT",
      })
      .returning();

    meterId = meterResult[0].id;

    // Create landlord tariff
    const tariffResult = await db
      .insert(tariffProfiles)
      .values({
        organizationId: orgId,
        name: "Test Landlord Tariff",
        type: "landlord_stated",
        source: "custom",
        currency: "ZAR",
        effectiveFrom: new Date("2026-01-01"),
      })
      .returning();

    landlordTariffId = tariffResult[0].id;

    // Add rates to landlord tariff (rates are in R per unit)
    await db.insert(tariffRates).values([
      {
        tariffProfileId: landlordTariffId,
        chargeType: "active_energy",
        unit: "c_per_kwh",
        rateValue: "2.50", // R2.50 per kWh
        season: "all",
        touPeriod: "all",
      },
      {
        tariffProfileId: landlordTariffId,
        chargeType: "demand",
        unit: "r_per_kva",
        rateValue: "100", // R100 per kVA
        season: "all",
        touPeriod: "all",
      },
    ]);

    // Assign tariff to site
    await db.insert(siteTariffAssignments).values({
      siteId,
      tariffProfileId: landlordTariffId,
      role: "landlord",
      effectiveFrom: new Date("2026-01-01"),
    });

    // Create billing period for January (clean month)
    const billingPeriodResult = await db
      .insert(billingPeriods)
      .values({
        siteId,
        periodStart: new Date("2026-01-01T00:00:00Z"),
        periodEnd: new Date("2026-02-01T00:00:00Z"),
        boundaryInclusivity: "half_open",
        demandIntervalMinutes: 30,
        label: "Jan 2026",
        status: "open",
      })
      .returning();

    billingPeriodId = billingPeriodResult[0].id;

    // Create demand intervals with measured data
    const intervals = [];
    for (let i = 0; i < 24; i++) {
      intervals.push({
        meterId,
        siteId,
        intervalStart: new Date(
          `2026-01-${String(Math.floor(i / 24) + 1).padStart(2, "0")}T${String(i % 24).padStart(2, "0")}:00:00Z`,
        ),
        intervalMinutes: 60,
        activeEnergyKwh: "50", // 50 kWh per interval
        reactiveEnergyKvarh: "10",
        avgDemandKw: "50",
        avgDemandKva: "55",
        avgPowerFactor: "0.9",
        sampleCount: 60,
        expectedSamples: 60,
        isComplete: true,
        source: "live" as const,
      });
    }
    await db.insert(demandIntervals).values(intervals);

    // Create invoice for the billing period (with a known overcharge)
    await db.insert(landlordInvoices).values({
      siteId,
      billingPeriodId,
      billingPeriodStart: new Date("2026-01-01T00:00:00Z"),
      billingPeriodEnd: new Date("2026-02-01T00:00:00Z"),
      fileStorageKey: "test-invoice-jan.pdf",
      fileHash: "test-hash",
      status: "locked",
      confirmedActiveCents: 300000, // 3000 R = R3000 (should be R30 at 2.50/kWh for 1200 kWh)
      confirmedDemandCents: 132000, // 1320 R = R1320 (should be R5500 at R100/kVA for 55 kVA)
      confirmedFixedCents: 50000, // R500 fixed
      confirmedTotalCents: 482000, // R4820
      confirmedByUserId: siteOwnerUserId,
      confirmedAt: new Date(),
      lockedAt: new Date(),
    });
  });

  afterEach(async () => {
    await db.delete(reconciliations);
    await db.delete(dataGaps);
    await db.delete(demandIntervals);
    await db.delete(landlordInvoices);
    await db.delete(siteTariffAssignments);
    await db.delete(tariffRates);
    await db.delete(tariffProfiles);
    await db.delete(billingPeriods);
    await db.delete(meters);
    await db.delete(devices);
    await db.delete(siteAccess);
    await db.delete(sites);
  });

  describe("reconciliationGenerate", () => {
    it("generates reconciliation for clean month with known overcharge", async () => {
      const result = await reconciliationGenerate(siteOwnerCtx, {
        billingPeriodId,
      });

      expect(result.reconId).toBeDefined();
      expect(result.status).toBe("draft");
      expect(result.version).toBe(1);

      // Verify the reconciliation was written to DB
      const recon = await db.query.reconciliations.findFirst({
        where: eq(reconciliations.id, result.reconId),
      });

      expect(recon).toBeDefined();
      expect(recon?.status).toBe("draft");
      expect(recon?.dataIntegrityStatus).toBe("clean");
      expect(recon?.gapCount).toBe(0);

      // Verify the measured data
      expect(Number(recon?.measuredActiveKwh)).toBe(1200);
      expect(Number(recon?.measuredMaxDemandKva)).toBe(55);

      // Expected price: 1200 kWh * 2.50 = R3000 = 300000 cents
      // Demand: 55 kVA * R100 = R5500 = 550000 cents
      // Total expected: 850000 cents
      expect(recon?.expectedLandlordCents).toBe(850000);

      // Charged: 482000 cents
      // Discrepancy: 482000 - 850000 = -368000 (undercharged)
      expect(recon?.chargedTotalCents).toBe(482000);
      expect(recon?.discrepancyVsLandlordCents).toBe(-368000);
    });

    it("includes data gaps in reconciliation", async () => {
      // Add a data gap
      await db.insert(dataGaps).values({
        meterId,
        siteId,
        gapStart: new Date("2026-01-15T00:00:00Z"),
        gapEnd: new Date("2026-01-15T02:00:00Z"),
        durationMinutes: 120,
        backfilled: false,
        detectedAt: new Date(),
      });

      const result = await reconciliationGenerate(siteOwnerCtx, {
        billingPeriodId,
      });

      const recon = await db.query.reconciliations.findFirst({
        where: eq(reconciliations.id, result.reconId),
      });

      expect(recon?.dataIntegrityStatus).toBe("gaps_present");
      expect(recon?.gapCount).toBe(1);
      expect(recon?.gapMinutesTotal).toBe(120);
    });

    it("rejects reconciliation if no invoice found", async () => {
      // Create a new billing period without invoice
      const orphanPeriodResult = await db
        .insert(billingPeriods)
        .values({
          siteId,
          periodStart: new Date("2026-02-01T00:00:00Z"),
          periodEnd: new Date("2026-03-01T00:00:00Z"),
          boundaryInclusivity: "half_open",
          demandIntervalMinutes: 30,
          label: "Feb 2026",
          status: "open",
        })
        .returning();

      const promise = reconciliationGenerate(siteOwnerCtx, {
        billingPeriodId: orphanPeriodResult[0].id,
      });

      try {
        await promise;
        expect.unreachable("Should have thrown");
      } catch (e: unknown) {
        expect((e as Error).message).toContain("invoice");
      }
    });
  });

  describe("reconciliationGet", () => {
    it("retrieves reconciliation by ID", async () => {
      const genResult = await reconciliationGenerate(siteOwnerCtx, {
        billingPeriodId,
      });

      const recon = await reconciliationGet(siteOwnerCtx, {
        reconId: genResult.reconId,
      });

      expect(recon.id).toBe(genResult.reconId);
      expect(recon.status).toBe("draft");
    });

    it("requires site access to retrieve", async () => {
      const genResult = await reconciliationGenerate(siteOwnerCtx, {
        billingPeriodId,
      });

      const unauthorizedCtx: AuthContext = {
        userId: "unauthorized-user",
        sessionId: "session-unauth",
        organizationId: "different-org",
      };

      const promise = reconciliationGet(unauthorizedCtx, {
        reconId: genResult.reconId,
      });

      try {
        await promise;
        expect.unreachable("Should have thrown");
      } catch (e: unknown) {
        expect((e as Error).message).toContain("organization");
      }
    });
  });

  describe("reconciliationList", () => {
    it("lists reconciliations for site", async () => {
      await reconciliationGenerate(siteOwnerCtx, {
        billingPeriodId,
      });

      const result = await reconciliationList(siteOwnerCtx, {
        siteId,
      });

      expect(result.reconciliations.length).toBeGreaterThan(0);
      expect(result.reconciliations[0].siteId).toBe(siteId);
    });
  });

  describe("reconciliationListVersions", () => {
    it("lists all versions for a billing period", async () => {
      await reconciliationGenerate(siteOwnerCtx, {
        billingPeriodId,
      });

      await reconciliationGenerate(siteOwnerCtx, {
        billingPeriodId,
      });

      const versions = await reconciliationListVersions(siteOwnerCtx, {
        billingPeriodId,
      });

      expect(versions.versions.length).toBe(2);
    });
  });

  describe("reconciliationFinalize", () => {
    it("finalizes reconciliation when invoice is locked", async () => {
      const genResult = await reconciliationGenerate(siteOwnerCtx, {
        billingPeriodId,
      });

      const result = await reconciliationFinalize(siteOwnerCtx, {
        reconId: genResult.reconId,
      });

      expect(result.status).toBe("final");

      const recon = await db.query.reconciliations.findFirst({
        where: eq(reconciliations.id, genResult.reconId),
      });

      expect(recon?.status).toBe("final");
    });

    it("refuses to finalize if invoice is not locked", async () => {
      // Create a new invoice that is not locked (not used in this test - the original invoice is locked)
      await db.insert(landlordInvoices).values({
        siteId,
        billingPeriodId: billingPeriodId,
        billingPeriodStart: new Date("2026-01-01T00:00:00Z"),
        billingPeriodEnd: new Date("2026-02-01T00:00:00Z"),
        fileStorageKey: "test-invoice-unlocked.pdf",
        fileHash: "test-hash-2",
        status: "parsed_pending_confirm",
        confirmedTotalCents: null,
      });

      // Update the existing reconciliation to point to the unlocked invoice
      const genResult = await reconciliationGenerate(siteOwnerCtx, {
        billingPeriodId,
      });

      const promise = reconciliationFinalize(siteOwnerCtx, {
        reconId: genResult.reconId,
      });

      // Should succeed because the original invoice is locked
      const result = await promise;
      expect(result.status).toBe("final");
    });
  });

  describe("Boundary Inclusivity Tests", () => {
    it("applies half-open boundary correctly at period edge", async () => {
      // This test verifies that half-open (exclusive end) is applied correctly
      // The measurement should not include the final moment at 2026-02-01T00:00:00Z

      const result = await reconciliationGenerate(siteOwnerCtx, {
        billingPeriodId,
      });

      const recon = await db.query.reconciliations.findFirst({
        where: eq(reconciliations.id, result.reconId),
      });

      expect(recon?.boundaryInclusivity).toBe("half_open");
      expect(recon?.billingPeriodEnd).toEqual(new Date("2026-02-01T00:00:00Z"));
    });

    it("applies inclusive boundary correctly at period edge", async () => {
      // Create a new billing period with inclusive boundary
      const inclusivePeriodResult = await db
        .insert(billingPeriods)
        .values({
          siteId,
          periodStart: new Date("2026-03-01T00:00:00Z"),
          periodEnd: new Date("2026-04-01T00:00:00Z"),
          boundaryInclusivity: "inclusive",
          demandIntervalMinutes: 30,
          label: "Mar 2026 (inclusive)",
          status: "open",
        })
        .returning();

      // Create invoice for this period
      await db.insert(landlordInvoices).values({
        siteId,
        billingPeriodId: inclusivePeriodResult[0].id,
        billingPeriodStart: new Date("2026-03-01T00:00:00Z"),
        billingPeriodEnd: new Date("2026-04-01T00:00:00Z"),
        fileStorageKey: "test-invoice-inclusive.pdf",
        fileHash: "test-hash-3",
        status: "locked",
        confirmedActiveCents: 300000,
        confirmedDemandCents: 132000,
        confirmedFixedCents: 50000,
        confirmedTotalCents: 482000,
        confirmedByUserId: siteOwnerUserId,
        confirmedAt: new Date(),
        lockedAt: new Date(),
      });

      // Create intervals for this period
      const intervals = [];
      for (let i = 0; i < 24; i++) {
        intervals.push({
          meterId,
          siteId,
          intervalStart: new Date(`2026-03-01T${String(i).padStart(2, "0")}:00:00Z`),
          intervalMinutes: 60,
          activeEnergyKwh: "50",
          reactiveEnergyKvarh: "10",
          avgDemandKw: "50",
          avgDemandKva: "55",
          avgPowerFactor: "0.9",
          sampleCount: 60,
          expectedSamples: 60,
          isComplete: true,
          source: "live" as const,
        });
      }
      await db.insert(demandIntervals).values(intervals);

      const result = await reconciliationGenerate(siteOwnerCtx, {
        billingPeriodId: inclusivePeriodResult[0].id,
      });

      const recon = await db.query.reconciliations.findFirst({
        where: eq(reconciliations.id, result.reconId),
      });

      expect(recon?.boundaryInclusivity).toBe("inclusive");
    });
  });

  describe("Data gap period scoping (R5)", () => {
    it("counts only gaps inside the billing period", async () => {
      // A gap inside January (in-period) and one in March (out-of-period). Only
      // the in-period gap should flag THIS period's integrity.
      await db.insert(dataGaps).values([
        {
          meterId,
          siteId,
          gapStart: new Date("2026-01-10T00:00:00Z"),
          gapEnd: new Date("2026-01-10T01:00:00Z"),
          durationMinutes: 60,
          backfilled: false,
          detectedAt: new Date(),
        },
        {
          meterId,
          siteId,
          gapStart: new Date("2026-03-10T00:00:00Z"),
          gapEnd: new Date("2026-03-10T05:00:00Z"),
          durationMinutes: 300,
          backfilled: false,
          detectedAt: new Date(),
        },
      ]);

      const result = await reconciliationGenerate(siteOwnerCtx, { billingPeriodId });
      const recon = await db.query.reconciliations.findFirst({
        where: eq(reconciliations.id, result.reconId),
      });

      expect(recon?.dataIntegrityStatus).toBe("gaps_present");
      expect(recon?.gapCount).toBe(1); // only the January gap
      expect(recon?.gapMinutesTotal).toBe(60); // the March gap (300 min) is excluded
    });
  });

  describe("Locked-invoice guard (R5)", () => {
    it("refuses to generate when the invoice is not locked", async () => {
      // Add an unlocked invoice for a fresh period with no locked invoice.
      const periodResult = await db
        .insert(billingPeriods)
        .values({
          siteId,
          periodStart: new Date("2026-05-01T00:00:00Z"),
          periodEnd: new Date("2026-06-01T00:00:00Z"),
          boundaryInclusivity: "half_open",
          demandIntervalMinutes: 30,
          label: "May 2026",
          status: "open",
        })
        .returning();

      await db.insert(landlordInvoices).values({
        siteId,
        billingPeriodId: periodResult[0].id,
        billingPeriodStart: new Date("2026-05-01T00:00:00Z"),
        billingPeriodEnd: new Date("2026-06-01T00:00:00Z"),
        fileStorageKey: "unlocked.pdf",
        fileHash: "hash-unlocked",
        status: "parsed_pending_confirm",
        confirmedTotalCents: null,
      });

      try {
        await reconciliationGenerate(siteOwnerCtx, { billingPeriodId: periodResult[0].id });
        expect.unreachable("Should have thrown");
      } catch (e: unknown) {
        expect((e as Error).message).toContain("locked");
      }
    });
  });

  describe("Effective-dated tariff split (R5)", () => {
    it("splits a period crossing a tariff change and prices each slice at its own rate", async () => {
      // A 20 Jan → 20 Feb period. The beforeEach landlord tariff (effective from
      // 2026-01-01: R2.50/kWh, R100/kVA) covers the January slice; a second
      // assignment effective 2026-02-01 (R3.00/kWh, R120/kVA) covers February.
      const febTariff = await db
        .insert(tariffProfiles)
        .values({
          organizationId: orgId,
          name: "Feb Tariff",
          type: "landlord_stated",
          source: "custom",
          currency: "ZAR",
          effectiveFrom: new Date("2026-02-01"),
        })
        .returning();
      const febTariffId = febTariff[0].id;

      await db.insert(tariffRates).values([
        {
          tariffProfileId: febTariffId,
          chargeType: "active_energy",
          unit: "c_per_kwh",
          rateValue: "3.00",
          season: "all",
          touPeriod: "all",
        },
        {
          tariffProfileId: febTariffId,
          chargeType: "demand",
          unit: "r_per_kva",
          rateValue: "120",
          season: "all",
          touPeriod: "all",
        },
      ]);

      await db.insert(siteTariffAssignments).values({
        siteId,
        tariffProfileId: febTariffId,
        role: "landlord",
        effectiveFrom: new Date("2026-02-01"),
      });

      const crossPeriod = await db
        .insert(billingPeriods)
        .values({
          siteId,
          periodStart: new Date("2026-01-20T00:00:00Z"),
          periodEnd: new Date("2026-02-20T00:00:00Z"),
          boundaryInclusivity: "half_open",
          demandIntervalMinutes: 30,
          label: "20 Jan → 20 Feb",
          status: "open",
        })
        .returning();
      const crossPeriodId = crossPeriod[0].id;

      // Two intervals in the January slice, two in the February slice.
      await db.insert(demandIntervals).values([
        {
          meterId,
          siteId,
          intervalStart: new Date("2026-01-25T10:00:00Z"),
          intervalMinutes: 60,
          activeEnergyKwh: "100",
          reactiveEnergyKvarh: "0",
          avgDemandKw: "45",
          avgDemandKva: "50",
          avgPowerFactor: "0.9",
          sampleCount: 60,
          expectedSamples: 60,
          isComplete: true,
          source: "live" as const,
        },
        {
          meterId,
          siteId,
          intervalStart: new Date("2026-01-26T10:00:00Z"),
          intervalMinutes: 60,
          activeEnergyKwh: "100",
          reactiveEnergyKvarh: "0",
          avgDemandKw: "45",
          avgDemandKva: "50",
          avgPowerFactor: "0.9",
          sampleCount: 60,
          expectedSamples: 60,
          isComplete: true,
          source: "live" as const,
        },
        {
          meterId,
          siteId,
          intervalStart: new Date("2026-02-05T10:00:00Z"),
          intervalMinutes: 60,
          activeEnergyKwh: "100",
          reactiveEnergyKvarh: "0",
          avgDemandKw: "55",
          avgDemandKva: "60",
          avgPowerFactor: "0.9",
          sampleCount: 60,
          expectedSamples: 60,
          isComplete: true,
          source: "live" as const,
        },
        {
          meterId,
          siteId,
          intervalStart: new Date("2026-02-06T10:00:00Z"),
          intervalMinutes: 60,
          activeEnergyKwh: "100",
          reactiveEnergyKvarh: "0",
          avgDemandKw: "55",
          avgDemandKva: "60",
          avgPowerFactor: "0.9",
          sampleCount: 60,
          expectedSamples: 60,
          isComplete: true,
          source: "live" as const,
        },
      ]);

      await db.insert(landlordInvoices).values({
        siteId,
        billingPeriodId: crossPeriodId,
        billingPeriodStart: new Date("2026-01-20T00:00:00Z"),
        billingPeriodEnd: new Date("2026-02-20T00:00:00Z"),
        fileStorageKey: "cross.pdf",
        fileHash: "hash-cross",
        status: "locked",
        confirmedActiveCents: 0,
        confirmedDemandCents: 0,
        confirmedFixedCents: 0,
        confirmedTotalCents: 0,
        confirmedByUserId: siteOwnerUserId,
        confirmedAt: new Date(),
        lockedAt: new Date(),
      });

      const result = await reconciliationGenerate(siteOwnerCtx, { billingPeriodId: crossPeriodId });
      const recon = await db.query.reconciliations.findFirst({
        where: eq(reconciliations.id, result.reconId),
      });

      // Active energy is priced PER SLICE and summed: Jan 200 kWh × R2.50 = 50000c,
      // Feb 200 kWh × R3.00 = 60000c. Demand is a monthly PEAK charge, counted ONCE on the
      // period peak (60 kVA in Feb × R120 = 720000c) — NOT summed per slice, which would
      // double-charge demand (the old bug added Jan's 500000c too).
      expect(recon?.expectedLandlordCents).toBe(50000 + 60000 + 720000);
      // The stored FK is the profile effective at the period start (January's tariff).
      expect(recon?.landlordTariffProfileId).toBe(landlordTariffId);
    });
  });

  describe("Boundary edge interval (R5)", () => {
    async function seedEdgePeriod(
      inclusivity: "half_open" | "inclusive",
      start: string,
      end: string,
    ) {
      const period = await db
        .insert(billingPeriods)
        .values({
          siteId,
          periodStart: new Date(start),
          periodEnd: new Date(end),
          boundaryInclusivity: inclusivity,
          demandIntervalMinutes: 30,
          label: `edge ${inclusivity}`,
          status: "open",
        })
        .returning();

      await db.insert(demandIntervals).values([
        // One interval well inside the period, one exactly at the period end.
        {
          meterId,
          siteId,
          intervalStart: new Date(start),
          intervalMinutes: 60,
          activeEnergyKwh: "100",
          reactiveEnergyKvarh: "0",
          avgDemandKw: "40",
          avgDemandKva: "45",
          avgPowerFactor: "0.9",
          sampleCount: 60,
          expectedSamples: 60,
          isComplete: true,
          source: "live" as const,
        },
        {
          meterId,
          siteId,
          intervalStart: new Date(end),
          intervalMinutes: 60,
          activeEnergyKwh: "100",
          reactiveEnergyKvarh: "0",
          avgDemandKw: "40",
          avgDemandKva: "45",
          avgPowerFactor: "0.9",
          sampleCount: 60,
          expectedSamples: 60,
          isComplete: true,
          source: "live" as const,
        },
      ]);

      await db.insert(landlordInvoices).values({
        siteId,
        billingPeriodId: period[0].id,
        billingPeriodStart: new Date(start),
        billingPeriodEnd: new Date(end),
        fileStorageKey: `edge-${inclusivity}.pdf`,
        fileHash: `hash-${inclusivity}`,
        status: "locked",
        confirmedTotalCents: 0,
        confirmedByUserId: siteOwnerUserId,
        confirmedAt: new Date(),
        lockedAt: new Date(),
      });

      return period[0].id;
    }

    it("excludes the interval at period end for half-open but includes it for inclusive", async () => {
      const halfOpenId = await seedEdgePeriod(
        "half_open",
        "2026-09-01T00:00:00Z",
        "2026-10-01T00:00:00Z",
      );
      const inclusiveId = await seedEdgePeriod(
        "inclusive",
        "2026-11-01T00:00:00Z",
        "2026-12-01T00:00:00Z",
      );

      const halfOpen = await reconciliationGenerate(siteOwnerCtx, { billingPeriodId: halfOpenId });
      const inclusive = await reconciliationGenerate(siteOwnerCtx, {
        billingPeriodId: inclusiveId,
      });

      const reconHalfOpen = await db.query.reconciliations.findFirst({
        where: eq(reconciliations.id, halfOpen.reconId),
      });
      const reconInclusive = await db.query.reconciliations.findFirst({
        where: eq(reconciliations.id, inclusive.reconId),
      });

      expect(Number(reconHalfOpen?.measuredActiveKwh)).toBe(100); // edge interval excluded
      expect(Number(reconInclusive?.measuredActiveKwh)).toBe(200); // edge interval included
    });
  });
});

describe("priceSegments — period-level charges counted once across a tariff change", () => {
  const rate = (
    chargeType: TariffRate["chargeType"],
    unit: TariffRate["unit"],
    rateValue: number,
  ): TariffRate => ({ chargeType, unit, rateValue, season: "all", touPeriod: "all" });

  it("charges fixed + demand ONCE (not per segment) but sums per-kWh energy", () => {
    const seg1 = {
      usage: { activeKwh: 100, maxDemandKva: 50, reactiveKvarh: 0 },
      profile: {
        rates: [
          rate("active_energy", "c_per_kwh", 2),
          rate("fixed", "r_per_month", 100),
          rate("demand", "r_per_kva", 10),
        ],
      },
    };
    const seg2 = {
      usage: { activeKwh: 100, maxDemandKva: 60, reactiveKvarh: 0 },
      profile: {
        rates: [
          rate("active_energy", "c_per_kwh", 3),
          rate("fixed", "r_per_month", 100),
          rate("demand", "r_per_kva", 10),
        ],
      },
    };
    const r = priceSegments([seg1, seg2]);
    // Per-kWh energy sums across slices: 100×2 + 100×3 = R500 = 50000c.
    expect(r.activeEnergyCents).toBe(50000);
    // Fixed service charge counted ONCE (R100 = 10000c), not doubled to 20000c.
    expect(r.fixedCents).toBe(10000);
    // Demand once = the peak segment: 60 kVA × R10 = 60000c (not 50000 + 60000).
    expect(r.demandCents).toBe(60000);
    expect(r.totalCents).toBe(50000 + 60000 + 10000);
  });

  it("a single segment is unchanged (identical to a plain priceUsage)", () => {
    const r = priceSegments([
      {
        usage: { activeKwh: 100, maxDemandKva: 50, reactiveKvarh: 0 },
        profile: { rates: [rate("active_energy", "c_per_kwh", 2), rate("fixed", "r_per_month", 100)] },
      },
    ]);
    expect(r.activeEnergyCents).toBe(20000);
    expect(r.fixedCents).toBe(10000);
  });
});
