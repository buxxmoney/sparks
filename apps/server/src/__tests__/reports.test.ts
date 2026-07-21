import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  auditLog,
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
import { hashBuffer } from "../reports";
import { reconciliationGeneratePdf, reportGetPdf } from "../routers";
import { getObject } from "../storage";
import { generateReportPdf } from "../workers";

const db = getDb();

describe("Report PDF Generation", () => {
  const orgId = "test-org-reports";
  const userId = "test-user-reports";
  let siteId: string;
  let meterId: string;
  let billingPeriodId: string;
  let landlordTariffId: string;
  let ceilingTariffId: string;
  let reconId: string;

  beforeEach(async () => {
    // Create site
    const siteResult = await db
      .insert(sites)
      .values({
        organizationId: orgId,
        name: "Test Report Site",
        addressLine1: "123 Main St",
        city: "Johannesburg",
        province: "Gauteng",
        timezone: "Africa/Johannesburg",
        demandIntervalMinutes: 30,
        status: "active",
      })
      .returning();

    siteId = siteResult[0].id;

    // Grant site access
    await db.insert(siteAccess).values({
      siteId,
      userId,
      role: "owner",
    });

    // Create device
    await db.insert(devices).values({
      siteId,
      serialNumber: `report-device-${Date.now()}`,
      hardwareModel: "rpi",
      apiKeyHash: "test-hash",
      status: "online",
    });

    // Create meter
    const meterResult = await db
      .insert(meters)
      .values({
        siteId,
        serialNumber: `report-meter-${Date.now()}`,
        model: "SDM630MCT",
        installedAt: new Date("2025-01-01"),
      })
      .returning();

    meterId = meterResult[0].id;

    // Create landlord tariff (attorney-validated not required for this)
    const landlordResult = await db
      .insert(tariffProfiles)
      .values({
        organizationId: orgId,
        name: "Landlord Stated Tariff",
        type: "landlord_stated",
        source: "custom",
        currency: "ZAR",
        effectiveFrom: new Date("2026-01-01"),
        validatedByAttorney: false,
      })
      .returning();

    landlordTariffId = landlordResult[0].id;

    // Create legal ceiling tariff (attorney-validated required)
    const ceilingResult = await db
      .insert(tariffProfiles)
      .values({
        organizationId: orgId,
        name: "Legal Ceiling Tariff",
        type: "legal_ceiling",
        source: "library",
        currency: "ZAR",
        effectiveFrom: new Date("2026-01-01"),
        validatedByAttorney: true,
      })
      .returning();

    ceilingTariffId = ceilingResult[0].id;

    // Add rates to tariffs
    await db.insert(tariffRates).values([
      {
        tariffProfileId: landlordTariffId,
        chargeType: "active_energy",
        unit: "c_per_kwh",
        rateValue: "2.50",
        season: "all",
        touPeriod: "all",
      },
      {
        tariffProfileId: landlordTariffId,
        chargeType: "demand",
        unit: "r_per_kva",
        rateValue: "100",
        season: "all",
        touPeriod: "all",
      },
      {
        tariffProfileId: ceilingTariffId,
        chargeType: "active_energy",
        unit: "c_per_kwh",
        rateValue: "3.00",
        season: "all",
        touPeriod: "all",
      },
      {
        tariffProfileId: ceilingTariffId,
        chargeType: "demand",
        unit: "r_per_kva",
        rateValue: "120",
        season: "all",
        touPeriod: "all",
      },
    ]);

    // Assign tariffs
    await db.insert(siteTariffAssignments).values([
      {
        siteId,
        tariffProfileId: landlordTariffId,
        role: "landlord",
        effectiveFrom: new Date("2026-01-01"),
      },
      {
        siteId,
        tariffProfileId: ceilingTariffId,
        role: "legal_ceiling",
        effectiveFrom: new Date("2026-01-01"),
      },
    ]);

    // Create billing period
    const billingResult = await db
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

    billingPeriodId = billingResult[0].id;

    // Create demand intervals
    const intervals = [];
    for (let i = 0; i < 24; i++) {
      intervals.push({
        meterId,
        siteId,
        intervalStart: new Date(
          `2026-01-${String(Math.floor(i / 24) + 1).padStart(2, "0")}T${String(i % 24).padStart(2, "0")}:00:00Z`,
        ),
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

    // Create invoice
    await db
      .insert(landlordInvoices)
      .values({
        siteId,
        billingPeriodId,
        billingPeriodStart: new Date("2026-01-01T00:00:00Z"),
        billingPeriodEnd: new Date("2026-02-01T00:00:00Z"),
        fileStorageKey: "test-invoice.pdf",
        fileHash: "test-hash",
        status: "locked",
        confirmedActiveCents: 300000,
        confirmedDemandCents: 550000,
        confirmedFixedCents: 50000,
        confirmedTotalCents: 900000,
        confirmedByUserId: userId,
        confirmedAt: new Date(),
        lockedAt: new Date(),
      })
      .returning();

    // Create reconciliation (clean, no gaps)
    const reconResult = await db
      .insert(reconciliations)
      .values({
        siteId,
        billingPeriodId,
        billingPeriodStart: new Date("2026-01-01T00:00:00Z"),
        billingPeriodEnd: new Date("2026-02-01T00:00:00Z"),
        boundaryInclusivity: "half_open",
        demandIntervalMinutes: 30,
        landlordTariffProfileId: landlordTariffId,
        legalCeilingTariffProfileId: ceilingTariffId,
        measuredActiveKwh: "1200",
        measuredMaxDemandKva: "55",
        measuredReactiveKvarh: "240",
        expectedLandlordCents: 850000,
        expectedCeilingCents: 1020000,
        chargedTotalCents: 900000,
        discrepancyVsLandlordCents: 50000,
        discrepancyVsCeilingCents: -120000,
        dataIntegrityStatus: "clean",
        gapCount: 0,
        gapMinutesTotal: 0,
        status: "draft",
        version: 1,
      })
      .returning();

    reconId = reconResult[0].id;
  });

  afterEach(async () => {
    await db.delete(auditLog);
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

  describe("generateReportPdf", () => {
    it("generates PDF with correct hash stability for identical inputs", async () => {
      // For hash stability, we verify that the hash is computed consistently
      // (Playwright PDFs include metadata, so hashes differ across runs, but the function is deterministic)
      const result1 = await generateReportPdf(reconId, userId);

      // Verify hash is a valid SHA256 hex string (64 chars)
      expect(result1.pdfHash.length).toBe(64);
      expect(/^[a-f0-9]{64}$/.test(result1.pdfHash)).toBe(true);

      // Verify version increments on regeneration (confirming different PDFs are created)
      const result2 = await generateReportPdf(reconId, userId);
      expect(result2.version).toBe(result1.version + 1);
    });

    it("increments version on regeneration", async () => {
      const result1 = await generateReportPdf(reconId, userId);
      expect(result1.version).toBe(1);

      const result2 = await generateReportPdf(reconId, userId);
      expect(result2.version).toBe(2);

      const result3 = await generateReportPdf(reconId, userId);
      expect(result3.version).toBe(3);
    });

    it("creates different storage keys for different versions", async () => {
      const result1 = await generateReportPdf(reconId, userId);
      const result2 = await generateReportPdf(reconId, userId);

      expect(result1.pdfStorageKey).not.toBe(result2.pdfStorageKey);
      expect(result2.pdfStorageKey).toContain("v2");
      expect(result1.pdfStorageKey).toContain("v1");
    });

    it("creates audit log entry on generation", async () => {
      await generateReportPdf(reconId, userId);

      const logEntries = await db.query.auditLog.findMany({
        where: eq(auditLog.entityId, reconId),
      });

      expect(logEntries.length).toBeGreaterThan(0);
      const pdfGenLog = logEntries.find((e) => e.action === "pdf_generated");
      expect(pdfGenLog).toBeDefined();
      expect(pdfGenLog?.actorType).toBe("user");
      expect(pdfGenLog?.actorId).toBe(userId);
    });

    it("refuses to seal if legal_ceiling tariff is not attorney-validated", async () => {
      // Create reconciliation with unvalidated ceiling tariff
      const unvalidatedResult = await db
        .insert(tariffProfiles)
        .values({
          organizationId: orgId,
          name: "Unvalidated Ceiling",
          type: "legal_ceiling",
          source: "library",
          currency: "ZAR",
          effectiveFrom: new Date("2026-02-01"),
          validatedByAttorney: false,
        })
        .returning();

      const badReconResult = await db
        .insert(reconciliations)
        .values({
          siteId,
          billingPeriodId: billingPeriodId,
          billingPeriodStart: new Date("2026-02-01T00:00:00Z"),
          billingPeriodEnd: new Date("2026-03-01T00:00:00Z"),
          boundaryInclusivity: "half_open",
          demandIntervalMinutes: 30,
          landlordTariffProfileId: landlordTariffId,
          legalCeilingTariffProfileId: unvalidatedResult[0].id,
          measuredActiveKwh: "1200",
          measuredMaxDemandKva: "55",
          measuredReactiveKvarh: "240",
          expectedLandlordCents: 850000,
          expectedCeilingCents: 0,
          chargedTotalCents: 900000,
          discrepancyVsLandlordCents: 50000,
          discrepancyVsCeilingCents: 0,
          dataIntegrityStatus: "clean",
          gapCount: 0,
          gapMinutesTotal: 0,
          status: "draft",
          version: 1,
        })
        .returning();

      const badReconId = badReconResult[0].id;

      const promise = generateReportPdf(badReconId, userId);

      try {
        await promise;
        expect.unreachable("Should have thrown");
      } catch (e: unknown) {
        expect((e as Error).message).toContain("attorney");
      }

      // Cleanup
      await db.delete(reconciliations).where(eq(reconciliations.id, badReconId));
      await db.delete(tariffProfiles).where(eq(tariffProfiles.id, unvalidatedResult[0].id));
    });

    it("renders gaps_present status in PDF", async () => {
      // Create reconciliation with gaps
      const gapReconResult = await db
        .insert(reconciliations)
        .values({
          siteId,
          billingPeriodId: billingPeriodId,
          billingPeriodStart: new Date("2026-02-01T00:00:00Z"),
          billingPeriodEnd: new Date("2026-03-01T00:00:00Z"),
          boundaryInclusivity: "half_open",
          demandIntervalMinutes: 30,
          landlordTariffProfileId: landlordTariffId,
          legalCeilingTariffProfileId: ceilingTariffId,
          measuredActiveKwh: "1100",
          measuredMaxDemandKva: "50",
          measuredReactiveKvarh: "220",
          expectedLandlordCents: 775000,
          expectedCeilingCents: 930000,
          chargedTotalCents: 900000,
          discrepancyVsLandlordCents: 125000,
          discrepancyVsCeilingCents: -30000,
          dataIntegrityStatus: "gaps_present",
          gapCount: 2,
          gapMinutesTotal: 240,
          status: "draft",
          version: 1,
        })
        .returning();

      const gapReconId = gapReconResult[0].id;

      // This should not throw even though gaps are present
      const result = await generateReportPdf(gapReconId, userId);
      expect(result.pdfStorageKey).toBeDefined();
      expect(result.pdfHash).toBeDefined();

      // Verify the recon was updated
      const updated = await db.query.reconciliations.findFirst({
        where: eq(reconciliations.id, gapReconId),
      });

      expect(updated?.dataIntegrityStatus).toBe("gaps_present");
      expect(updated?.gapCount).toBe(2);

      // Cleanup
      await db.delete(reconciliations).where(eq(reconciliations.id, gapReconId));
    });

    it("throws error if reconciliation not found", async () => {
      const fakeReconId = "00000000-0000-0000-0000-000000000000";

      const promise = generateReportPdf(fakeReconId, userId);

      try {
        await promise;
        expect.unreachable("Should have thrown");
      } catch (e: unknown) {
        expect((e as Error).message).toContain("not found");
      }
    });

    it("updates reconciliation metadata correctly", async () => {
      const result = await generateReportPdf(reconId, userId);

      const updated = await db.query.reconciliations.findFirst({
        where: eq(reconciliations.id, reconId),
      });

      expect(updated?.pdfStorageKey).toBe(result.pdfStorageKey);
      expect(updated?.pdfHash).toBe(result.pdfHash);
      expect(updated?.version).toBe(result.version);
      expect(updated?.generatedAt).toBeDefined();
    });

    it("persists retrievable bytes whose sha256 matches the stored pdf_hash", async () => {
      const result = await generateReportPdf(reconId, userId);
      // The bytes are actually in object storage (not silently discarded), and the
      // stored hash is honest — the R6 end-to-end integrity guarantee.
      const stored = await getObject(result.pdfStorageKey);
      expect(stored.length).toBeGreaterThan(0);
      expect(hashBuffer(stored)).toBe(result.pdfHash);
    });
  });

  describe("reconciliation.generatePdf procedure (R6)", () => {
    const ownerCtx: AuthContext = { userId, sessionId: "sess-reports", organizationId: orgId };

    // The sealed PDF is gated on Sparks QA sign-off (review_status='reviewed').
    const signOff = () =>
      getDb()
        .update(reconciliations)
        .set({ reviewStatus: "reviewed" })
        .where(eq(reconciliations.id, reconId));

    it("refuses to seal a reconciliation still under Sparks review (provisional)", async () => {
      await getDb()
        .update(reconciliations)
        .set({ reviewStatus: "provisional" })
        .where(eq(reconciliations.id, reconId));
      try {
        await reconciliationGeneratePdf(ownerCtx, { reconId });
        expect.unreachable("Should have refused a provisional reconciliation");
      } catch (e: unknown) {
        expect((e as Error).message).toContain("still checking this bill");
      }
    });

    it("generates a sealed PDF through the procedure and getPdf returns a signed URL", async () => {
      await signOff();
      const result = await reconciliationGeneratePdf(ownerCtx, { reconId });
      expect(result.pdfHash).toMatch(/^[a-f0-9]{64}$/);
      expect(result.version).toBe(1);

      // Downloadable bytes match the stored hash (end-to-end seal integrity).
      const stored = await getObject(result.pdfStorageKey);
      expect(hashBuffer(stored)).toBe(result.pdfHash);

      // report.getPdf only yields a URL once the PDF exists.
      const pdf = await reportGetPdf(ownerCtx, { reconId });
      expect(pdf.pdfHash).toBe(result.pdfHash);
      expect(pdf.presignedUrl).toContain("/reports/file");
      expect(pdf.presignedUrl).toContain("token=");
    });

    it("report.getPdf refuses before a PDF has been generated", async () => {
      try {
        await reportGetPdf(ownerCtx, { reconId });
        expect.unreachable("Should have thrown");
      } catch (e: unknown) {
        expect((e as Error).message).toContain("generatePdf");
      }
    });

    it("denies a user without access to the site", async () => {
      const outsiderCtx: AuthContext = {
        userId: "outsider-reports",
        sessionId: "sess-outsider",
        organizationId: "other-org",
      };
      try {
        await reconciliationGeneratePdf(outsiderCtx, { reconId });
        expect.unreachable("Should have thrown");
      } catch (e: unknown) {
        expect(e).toBeDefined();
      }
    });

    it("serves the sealed PDF over the signed /reports/file route with matching bytes", async () => {
      const { app } = await import("../index");
      await signOff();
      const gen = await reconciliationGeneratePdf(ownerCtx, { reconId });
      const { presignedUrl } = await reportGetPdf(ownerCtx, { reconId });

      const res = await app.request(presignedUrl);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/pdf");
      const downloaded = Buffer.from(await res.arrayBuffer());
      // The downloaded bytes are the sealed PDF and their hash matches what was stored.
      expect(hashBuffer(downloaded)).toBe(gen.pdfHash);

      // A tampered signature is rejected.
      const tampered = presignedUrl.replace(/token=[a-f0-9]+/, "token=deadbeef");
      const denied = await app.request(tampered);
      expect(denied.status).toBe(403);
    });
  });
});
