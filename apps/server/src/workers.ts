import {
  alerts,
  auditLog,
  dataGaps,
  db,
  demandIntervals,
  devices,
  landlordInvoices,
  meters,
  readings,
  reconciliations,
  sites,
  tariffProfiles,
} from "@sparks/db";
import { and, asc, eq } from "drizzle-orm";
import { parseInvoiceWithClaude, persistParsedInvoice } from "./invoices";
import { PreconditionError } from "./middleware";
import { hashBuffer, renderHtmlToPdf, renderReportHtml } from "./reports";
import { putObject } from "./storage";

/**
 * Aggregate readings into demand intervals for a meter.
 * Computes clock-aligned intervals in UTC.
 * Derives avg_demand_kw/kva from cumulative energy deltas.
 */
export async function aggregateDemandIntervals(meterId: string): Promise<void> {
  const meterList = await db.select().from(meters).where(eq(meters.id, meterId)).limit(1);

  const meter = meterList[0];
  if (!meter) {
    throw new Error(`Meter ${meterId} not found`);
  }

  const siteList = await db.select().from(sites).where(eq(sites.id, meter.siteId)).limit(1);

  const site = siteList[0];
  if (!site) {
    throw new Error(`Site for meter ${meterId} not found`);
  }

  const intervalMinutes = site.demandIntervalMinutes;

  const meterReadings = await db
    .select()
    .from(readings)
    .where(eq(readings.meterId, meterId))
    .orderBy(asc(readings.time));

  if (meterReadings.length === 0) {
    return;
  }

  const startTime = new Date(meterReadings[0]?.time || new Date());
  const endTime = new Date(meterReadings[meterReadings.length - 1]?.time || new Date());

  const intervals = computeIntervals(startTime, endTime, intervalMinutes);

  // Interval energy from CUMULATIVE registers: the register value at the interval END
  // boundary minus the value at its START boundary, each = the last reading at or before
  // that boundary. This attributes consumption that straddles a boundary to the right
  // interval, handles single-sample intervals (old first/last-WITHIN logic yielded 0), and
  // Σ interval deltas telescopes to (last register − first register), conserving energy.
  type EnergyField = "activeEnergyKwh" | "reactiveEnergyKvarh" | "apparentEnergyKvah";
  const earliestRegister = (field: EnergyField): number | null => {
    for (const r of meterReadings) {
      if (r[field] != null) return Number.parseFloat(r[field] as string);
    }
    return null;
  };
  const registerAtOrBefore = (field: EnergyField, t: Date): number | null => {
    let val: number | null = null;
    for (const r of meterReadings) {
      if (new Date(r.time).getTime() > t.getTime()) break;
      if (r[field] != null) val = Number.parseFloat(r[field] as string);
    }
    // Before the first reading ⇒ baseline at the earliest register (no energy yet consumed).
    return val ?? earliestRegister(field);
  };
  const intervalEnergy = (field: EnergyField, start: Date, end: Date): string => {
    const a = registerAtOrBefore(field, start);
    const b = registerAtOrBefore(field, end);
    if (a === null || b === null) return "0";
    const delta = b - a;
    // A negative delta is a cumulative-register rollover / meter reset — never emit negative
    // energy; clamp to 0 (detectDataGaps flags the discontinuity separately).
    return (delta < 0 ? 0 : delta).toFixed(3);
  };

  for (const interval of intervals) {
    const intervalReadings = meterReadings.filter(
      (r) => new Date(r.time) >= interval.start && new Date(r.time) < interval.end,
    );

    if (intervalReadings.length === 0) {
      continue;
    }

    const sampleCount = intervalReadings.length;
    const expectedSamples = Math.ceil((intervalMinutes * 60) / 60);

    const activeEnergyDelta = intervalEnergy("activeEnergyKwh", interval.start, interval.end);
    const reactiveEnergyDelta = intervalEnergy("reactiveEnergyKvarh", interval.start, interval.end);
    const apparentEnergyDelta = intervalEnergy("apparentEnergyKvah", interval.start, interval.end);

    const intervalHours = intervalMinutes / 60;
    const avgDemandKw = (Number.parseFloat(activeEnergyDelta) / intervalHours).toFixed(3);
    const avgDemandKva = (Number.parseFloat(apparentEnergyDelta) / intervalHours).toFixed(3);

    const avgPowerFactor =
      intervalReadings.length > 0
        ? (
            intervalReadings
              .filter((r) => r.powerFactor)
              .reduce((sum, r) => sum + Number.parseFloat(r.powerFactor || "0"), 0) /
            intervalReadings.filter((r) => r.powerFactor).length
          ).toFixed(4)
        : null;

    const isComplete = sampleCount >= expectedSamples * 0.9;

    await db
      .insert(demandIntervals)
      .values({
        meterId,
        siteId: meter.siteId,
        intervalStart: interval.start,
        intervalMinutes,
        activeEnergyKwh: activeEnergyDelta,
        reactiveEnergyKvarh: reactiveEnergyDelta,
        avgDemandKw: avgDemandKw,
        avgDemandKva: avgDemandKva,
        avgPowerFactor: avgPowerFactor,
        sampleCount,
        expectedSamples,
        isComplete,
        source: "live",
      })
      .onConflictDoUpdate({
        target: [
          demandIntervals.meterId,
          demandIntervals.intervalStart,
          demandIntervals.intervalMinutes,
        ],
        set: {
          activeEnergyKwh: activeEnergyDelta,
          reactiveEnergyKvarh: reactiveEnergyDelta,
          avgDemandKw: avgDemandKw,
          avgDemandKva: avgDemandKva,
          avgPowerFactor: avgPowerFactor,
          sampleCount,
          expectedSamples,
          isComplete,
        },
      });
  }
}

/**
 * Compute clock-aligned intervals for a time range.
 * Intervals align to boundaries like 00:00, 00:30, 01:00, etc.
 */
function computeIntervals(
  startTime: Date,
  endTime: Date,
  intervalMinutes: number,
): Array<{ start: Date; end: Date }> {
  const intervals: Array<{ start: Date; end: Date }> = [];

  let current = alignToInterval(startTime, intervalMinutes);

  while (current < endTime) {
    const next = new Date(current.getTime() + intervalMinutes * 60 * 1000);
    intervals.push({ start: new Date(current), end: next });
    current = next;
  }

  return intervals;
}

/**
 * Align a UTC time to the nearest interval boundary (e.g., aligned to 00:00, 00:30).
 */
function alignToInterval(date: Date, intervalMinutes: number): Date {
  const ms = date.getTime();
  const intervalMs = intervalMinutes * 60 * 1000;
  const aligned = Math.floor(ms / intervalMs) * intervalMs;
  return new Date(aligned);
}

/**
 * Detect data gaps based on sequence discontinuity or incomplete intervals.
 */
export async function detectDataGaps(meterId: string): Promise<void> {
  const meterList = await db.select().from(meters).where(eq(meters.id, meterId)).limit(1);

  const meter = meterList[0];
  if (!meter) {
    throw new Error(`Meter ${meterId} not found`);
  }

  const meterReadings = await db
    .select()
    .from(readings)
    .where(eq(readings.meterId, meterId))
    .orderBy(asc(readings.time));

  if (meterReadings.length < 2) {
    return;
  }

  const gaps: Array<{ start: Date; end: Date; reason: string }> = [];

  for (let i = 0; i < meterReadings.length - 1; i++) {
    const current = meterReadings[i];
    const next = meterReadings[i + 1];
    if (!current || !next) continue;

    const currentSeq = current.seq ? Number(current.seq) : null;
    const nextSeq = next.seq ? Number(next.seq) : null;

    if (currentSeq && nextSeq && nextSeq - currentSeq > 1) {
      gaps.push({
        start: new Date(current.time),
        end: new Date(next.time),
        reason: "seq_discontinuity",
      });
    }
  }

  const incompleteIntervals = await db
    .select()
    .from(demandIntervals)
    .where(and(eq(demandIntervals.meterId, meterId), eq(demandIntervals.isComplete, false)));

  for (const interval of incompleteIntervals) {
    const intervalStart = new Date(interval.intervalStart);
    const intervalEnd = new Date(intervalStart.getTime() + interval.intervalMinutes * 60000);

    const existingList = await db
      .select()
      .from(dataGaps)
      .where(
        and(
          eq(dataGaps.meterId, meterId),
          eq(dataGaps.gapStart, intervalStart),
          eq(dataGaps.gapEnd, intervalEnd),
        ),
      )
      .limit(1);

    const existing = existingList[0];

    if (!existing) {
      gaps.push({
        start: intervalStart,
        end: intervalEnd,
        reason: "incomplete_interval",
      });
    }
  }

  for (const gap of gaps) {
    const durationMinutes = (gap.end.getTime() - gap.start.getTime()) / (1000 * 60);

    await db
      .insert(dataGaps)
      .values({
        meterId,
        siteId: meter.siteId,
        gapStart: gap.start,
        gapEnd: gap.end,
        durationMinutes: Math.ceil(durationMinutes),
        backfilled: false,
      })
      .onConflictDoNothing({
        target: [dataGaps.meterId, dataGaps.gapStart, dataGaps.gapEnd],
      });
  }
}

/**
 * Evaluate device offline status and create alerts.
 */
export async function evaluateDeviceOffline(
  deviceId: string,
  thresholdMinutes = 15,
): Promise<void> {
  const deviceList = await db.select().from(devices).where(eq(devices.id, deviceId)).limit(1);

  const device = deviceList[0];
  if (!device) {
    throw new Error(`Device ${deviceId} not found`);
  }

  if (!device.siteId) {
    throw new Error(`Device ${deviceId} not associated with a site`);
  }

  const siteList = await db.select().from(sites).where(eq(sites.id, device.siteId)).limit(1);

  const site = siteList[0];
  if (!site) {
    throw new Error(`Site for device ${deviceId} not found`);
  }

  const now = new Date();
  const threshold = new Date(now.getTime() - thresholdMinutes * 60 * 1000);

  const lastSeen = device.lastSeenAt ? new Date(device.lastSeenAt) : null;
  const isOffline = !lastSeen || lastSeen < threshold;

  if (isOffline && device.status !== "offline") {
    const existingAlertList = await db
      .select()
      .from(alerts)
      .where(
        and(
          eq(alerts.deviceId, deviceId),
          eq(alerts.type, "device_offline"),
          eq(alerts.status, "open"),
        ),
      )
      .limit(1);

    const existingAlert = existingAlertList[0];

    if (!existingAlert) {
      await db.insert(alerts).values({
        organizationId: site.organizationId,
        siteId: site.id,
        deviceId,
        type: "device_offline",
        severity: "critical",
        title: "Device Offline",
        message: `Device ${device.serialNumber} has not reported data for ${thresholdMinutes} minutes`,
        status: "open",
      });
    }

    await db
      .update(devices)
      .set({ status: "offline", updatedAt: now })
      .where(eq(devices.id, deviceId));
  }

  if (!isOffline && device.status === "offline") {
    await db
      .update(devices)
      .set({ status: "online", updatedAt: now })
      .where(eq(devices.id, deviceId));

    const offlineAlertList = await db
      .select()
      .from(alerts)
      .where(
        and(
          eq(alerts.deviceId, deviceId),
          eq(alerts.type, "device_offline"),
          eq(alerts.status, "open"),
        ),
      )
      .limit(1);

    const offlineAlert = offlineAlertList[0];
    if (offlineAlert) {
      await db
        .update(alerts)
        .set({ status: "resolved", resolvedAt: now })
        .where(eq(alerts.id, offlineAlert.id));
    }
  }
}

/**
 * Parse a landlord invoice PDF using Claude vision + structured tool-use.
 * Renders PDF to images, calls Claude, extracts line items, validates arithmetic,
 * flags impermissible add-ons, and persists results.
 */
export async function triggerInvoiceParse(invoiceId: string, pdfContent: Buffer): Promise<void> {
  const invoice = await db.query.landlordInvoices.findFirst({
    where: eq(landlordInvoices.id, invoiceId),
  });

  if (!invoice) {
    throw new Error(`Invoice ${invoiceId} not found`);
  }

  if (invoice.status !== "uploaded") {
    throw new Error(`Invoice ${invoiceId} is not in uploaded status`);
  }

  try {
    await db
      .update(landlordInvoices)
      .set({ status: "parsing" })
      .where(eq(landlordInvoices.id, invoiceId));

    const parsed = await parseInvoiceWithClaude(pdfContent);
    await persistParsedInvoice(invoiceId, parsed);
  } catch (error) {
    await db
      .update(landlordInvoices)
      .set({ status: "uploaded" })
      .where(eq(landlordInvoices.id, invoiceId));

    throw error;
  }
}

/**
 * Generate and seal a dispute-ready PDF report for a reconciliation.
 * Includes provenance (meter, installer), measured vs. expected pricing, data-integrity status.
 * Refuses seal if legal_ceiling tariff is not attorney-validated.
 * Stores PDF in private bucket; bumps version on regeneration (never overwrites prior versions).
 * Writes audit_log entry on generation.
 */
export async function generateReportPdf(
  reconId: string,
  userId: string,
): Promise<{ pdfStorageKey: string; pdfHash: string; version: number }> {
  const recon = await db.query.reconciliations.findFirst({
    where: eq(reconciliations.id, reconId),
  });

  if (!recon) {
    throw new Error(`Reconciliation ${reconId} not found`);
  }

  // Fetch related data
  const site = await db.query.sites.findFirst({
    where: eq(sites.id, recon.siteId),
  });

  if (!site) {
    throw new Error("Site for reconciliation not found");
  }

  // Get meter data (assume one meter per site for this phase)
  const meter = await db.query.meters.findFirst({
    where: eq(meters.siteId, recon.siteId),
  });

  if (!meter) {
    // A sealed dispute PDF is meter-measured evidence, so it needs a meter installed
    // on the site. Surface this as an actionable message, not a generic 500.
    throw new PreconditionError(
      "This site has no meter installed, so a sealed dispute PDF can't be generated — it relies on meter-measured usage. You can still send the customer your written review outcome.",
    );
  }

  // Get device data
  const device = await db.query.devices.findFirst({
    where: eq(devices.id, meter.deviceId),
  });

  if (!device) {
    throw new PreconditionError(
      "The meter on this site isn't linked to a device yet, so a sealed dispute PDF can't be generated.",
    );
  }

  // Get tariff names and validate legal_ceiling attorney status
  let landlordTariffName = "Unknown";
  let ceilingTariffName: string | null = null;

  if (recon.landlordTariffProfileId) {
    const landlordTariff = await db.query.tariffProfiles.findFirst({
      where: eq(tariffProfiles.id, recon.landlordTariffProfileId),
    });
    if (landlordTariff) {
      landlordTariffName = landlordTariff.name;
    }
  }

  if (recon.legalCeilingTariffProfileId) {
    const ceilingTariff = await db.query.tariffProfiles.findFirst({
      where: eq(tariffProfiles.id, recon.legalCeilingTariffProfileId),
    });
    if (ceilingTariff) {
      ceilingTariffName = ceilingTariff.name;
      // GUARD: Refuse to seal if legal_ceiling tariff is not attorney-validated
      if (!ceilingTariff.validatedByAttorney) {
        throw new Error(
          `Cannot seal report: legal ceiling tariff "${ceilingTariff.name}" has not been validated by attorney. Set validatedByAttorney=true before generating dispute-ready PDF.`,
        );
      }
    }
  }

  // Render report HTML
  const html = renderReportHtml({
    reconciliation: recon,
    site,
    meter,
    device,
    landlordTariffName,
    ceilingTariffName,
  });

  // Convert HTML to PDF
  const pdfBuffer = await renderHtmlToPdf(html);
  const pdfHash = hashBuffer(pdfBuffer);

  // Determine version and storage key
  // If PDF already exists, increment version; otherwise start at 1
  const currentVersion = recon.version || 1;
  const newVersion = recon.pdfStorageKey ? currentVersion + 1 : 1;
  const pdfStorageKey = `reports/${recon.siteId}/${recon.id}/v${newVersion}.pdf`;

  // Persist the sealed PDF bytes to object storage. A new versioned key means
  // prior versions are never overwritten (immutable evidence trail).
  await putObject(pdfStorageKey, pdfBuffer);

  // Update reconciliation with PDF metadata
  await db
    .update(reconciliations)
    .set({
      pdfStorageKey,
      pdfHash,
      generatedAt: new Date(),
      version: newVersion,
    })
    .where(eq(reconciliations.id, reconId));

  // Write audit log entry
  await db.insert(auditLog).values({
    entityType: "reconciliation",
    entityId: reconId,
    action: "pdf_generated",
    actorType: "user",
    actorId: userId,
    diff: {
      pdfStorageKey,
      pdfHash,
      version: newVersion,
    },
  });

  return { pdfStorageKey, pdfHash, version: newVersion };
}
