import { db } from "./index";
import {
  billingCyclePolicies,
  billingPeriods,
  devices,
  meters,
  siteAccess,
  siteTariffAssignments,
  sites,
  tariffProfiles,
  tariffRates,
} from "./schema";

async function seed() {
  console.log("🌱 Starting seed...");

  // Generate reproducible UUIDs (seeded with fixed string for reproducibility)
  const orgId = "550e8400-e29b-41d4-a716-446655440001";
  const ownerUserId = "550e8400-e29b-41d4-a716-446655440002";
  const operatorUserId = "550e8400-e29b-41d4-a716-446655440003";
  const siteId = "550e8400-e29b-41d4-a716-446655440010";
  const policyId = "550e8400-e29b-41d4-a716-446655440011";
  const period1Id = "550e8400-e29b-41d4-a716-446655440012";
  const period2Id = "550e8400-e29b-41d4-a716-446655440013";
  const deviceId = "550e8400-e29b-41d4-a716-446655440020";
  const meterId = "550e8400-e29b-41d4-a716-446655440021";
  const tariffLegalId = "550e8400-e29b-41d4-a716-446655440030";
  const tariffLandlordId = "550e8400-e29b-41d4-a716-446655440031";

  // Note: Organization and Users are managed by better-auth.
  // The seed assumes these are pre-created. In production, use better-auth API.

  try {
    // 1. Create a site
    console.log("📍 Creating site...");
    await db.insert(sites).values({
      id: siteId,
      organizationId: orgId,
      name: "Test Restaurant - Shopping Centre",
      addressLine1: "123 Main Street",
      city: "Johannesburg",
      province: "Gauteng",
      supplyZone: "Eskom_JHB",
      timezone: "Africa/Johannesburg",
      demandIntervalMinutes: 30,
      status: "active",
    });

    // 2. Create site access for owner
    console.log("👤 Creating site access...");
    await db.insert(siteAccess).values({
      siteId,
      userId: ownerUserId,
      role: "owner" as const,
    });

    // 3. Create billing cycle policy (day_of_month, anchor_day=20, clamp_last_day)
    console.log("📅 Creating billing cycle policy...");
    const policyDate = new Date("2026-07-20T00:00:00Z");
    await db.insert(billingCyclePolicies).values({
      id: policyId,
      siteId,
      recurrence: "day_of_month" as const,
      anchorDay: 20,
      shortMonthPolicy: "clamp_last_day" as const,
      boundaryInclusivity: "half_open" as const,
      snapToDemandGrid: true,
      effectiveFrom: policyDate,
    });

    // 4. Create two materialized billing periods
    // Period 1: 2026-06-20 to 2026-07-20
    // Period 2: 2026-07-20 to 2026-08-20
    console.log("📊 Creating billing periods...");
    const period1Start = new Date("2026-06-20T00:00:00Z");
    const period1End = new Date("2026-07-20T00:00:00Z");
    const period2Start = new Date("2026-07-20T00:00:00Z");
    const period2End = new Date("2026-08-20T00:00:00Z");

    await db.insert(billingPeriods).values([
      {
        id: period1Id,
        siteId,
        periodStart: period1Start,
        periodEnd: period1End,
        boundaryInclusivity: "half_open" as const,
        demandIntervalMinutes: 30,
        label: "20 Jun–20 Jul 2026",
        source: "generated" as const,
        policyId,
        status: "closed" as const,
      },
      {
        id: period2Id,
        siteId,
        periodStart: period2Start,
        periodEnd: period2End,
        boundaryInclusivity: "half_open" as const,
        demandIntervalMinutes: 30,
        label: "20 Jul–20 Aug 2026",
        source: "generated" as const,
        policyId,
        status: "open" as const,
      },
    ]);

    // 5. Create a device
    console.log("🔧 Creating device...");
    await db.insert(devices).values({
      id: deviceId,
      siteId,
      serialNumber: "RPi-TEST-001",
      hardwareModel: "rpi",
      simProvider: "Vodacom",
      connectivityMode: "lte" as const,
      status: "online" as const,
      apiKeyHash: "sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    });

    // 6. Create a meter
    console.log("⚡ Creating meter...");
    await db.insert(meters).values({
      id: meterId,
      deviceId,
      siteId,
      serialNumber: "SDM630-001",
      model: "SDM630MCT",
      midCertifiedVariant: true,
      midCertificateRef: "MID-ZA-2024-001",
      ctRatioPrimary: 100,
      ctRatioSecondary: 5,
      phaseConfig: "3P4W",
      installedByName: "John Electrician",
      installerRegistration: "WM12345",
      installedAt: new Date("2026-06-01T00:00:00Z"),
      commissionedAt: new Date("2026-06-05T10:30:00Z"),
    });

    // 7. Create legal ceiling tariff
    console.log("💰 Creating legal ceiling tariff...");
    const legalTariffDate = new Date("2026-04-01T00:00:00Z");
    await db.insert(tariffProfiles).values({
      id: tariffLegalId,
      name: "Eskom_Legal_Ceiling_JHB_2026",
      type: "legal_ceiling" as const,
      source: "library" as const,
      supplyZone: "Eskom_JHB",
      distributor: "Eskom",
      currency: "ZAR",
      effectiveFrom: legalTariffDate,
      validatedByAttorney: true,
    });

    // Add rates to legal ceiling tariff
    await db.insert(tariffRates).values([
      {
        tariffProfileId: tariffLegalId,
        chargeType: "active_energy" as const,
        unit: "c_per_kwh" as const,
        rateValue: "225.5",
        season: "all" as const,
        touPeriod: "all" as const,
      },
      {
        tariffProfileId: tariffLegalId,
        chargeType: "demand" as const,
        unit: "r_per_kva" as const,
        rateValue: "85.0",
        season: "all" as const,
        touPeriod: "all" as const,
      },
      {
        tariffProfileId: tariffLegalId,
        chargeType: "reactive_energy" as const,
        unit: "c_per_kvarh" as const,
        rateValue: "45.3",
        season: "all" as const,
        touPeriod: "all" as const,
      },
      {
        tariffProfileId: tariffLegalId,
        chargeType: "fixed" as const,
        unit: "r_per_month" as const,
        rateValue: "850.0",
        season: "all" as const,
        touPeriod: "all" as const,
      },
    ]);

    // 8. Create landlord tariff (charged to tenant)
    console.log("🏢 Creating landlord tariff...");
    await db.insert(tariffProfiles).values({
      id: tariffLandlordId,
      organizationId: orgId,
      name: "Shopping_Centre_Resale_Tariff_2026",
      type: "landlord_stated" as const,
      source: "custom" as const,
      supplyZone: "Eskom_JHB",
      currency: "ZAR",
      effectiveFrom: legalTariffDate,
      validatedByAttorney: false,
    });

    // Add rates to landlord tariff (slightly marked up)
    await db.insert(tariffRates).values([
      {
        tariffProfileId: tariffLandlordId,
        chargeType: "active_energy" as const,
        unit: "c_per_kwh" as const,
        rateValue: "250.0",
        season: "all" as const,
        touPeriod: "all" as const,
      },
      {
        tariffProfileId: tariffLandlordId,
        chargeType: "demand" as const,
        unit: "r_per_kva" as const,
        rateValue: "95.0",
        season: "all" as const,
        touPeriod: "all" as const,
      },
      {
        tariffProfileId: tariffLandlordId,
        chargeType: "reactive_energy" as const,
        unit: "c_per_kvarh" as const,
        rateValue: "50.0",
        season: "all" as const,
        touPeriod: "all" as const,
      },
      {
        tariffProfileId: tariffLandlordId,
        chargeType: "fixed" as const,
        unit: "r_per_month" as const,
        rateValue: "1000.0",
        season: "all" as const,
        touPeriod: "all" as const,
      },
    ]);

    // 9. Assign tariffs to site
    console.log("🔗 Assigning tariffs to site...");
    await db.insert(siteTariffAssignments).values([
      {
        siteId,
        tariffProfileId: tariffLandlordId,
        role: "landlord" as const,
        effectiveFrom: legalTariffDate,
      },
      {
        siteId,
        tariffProfileId: tariffLegalId,
        role: "legal_ceiling" as const,
        effectiveFrom: legalTariffDate,
      },
    ]);

    console.log("✅ Seed completed successfully!");
    console.log("\n📋 Seeded data summary:");
    console.log(`  Organization ID: ${orgId}`);
    console.log(`  Owner User ID: ${ownerUserId}`);
    console.log(`  Operator User ID: ${operatorUserId}`);
    console.log(`  Site ID: ${siteId}`);
    console.log(`  Device ID: ${deviceId}`);
    console.log(`  Meter ID: ${meterId}`);
  } catch (error) {
    console.error("❌ Seed failed:", error);
    process.exit(1);
  }
}

seed();
