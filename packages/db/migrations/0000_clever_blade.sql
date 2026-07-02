DO $$ BEGIN
 CREATE TYPE "alert_severity" AS ENUM('info', 'warning', 'critical');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "alert_status" AS ENUM('open', 'acknowledged', 'resolved');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "alert_type" AS ENUM('device_offline', 'sim_down', 'data_gap', 'ups_degraded', 'power_restored', 'demand_spike', 'invoice_ready');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "billing_period_source" AS ENUM('generated', 'manual', 'meter_read', 'invoice_derived');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "billing_period_status" AS ENUM('open', 'closed');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "billing_recurrence" AS ENUM('calendar_month', 'day_of_month', 'n_monthly', 'weekly', 'fiscal', 'meter_read', 'manual');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "boundary_inclusivity" AS ENUM('half_open', 'inclusive', 'half_open_end');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "charge_type" AS ENUM('active_energy', 'demand', 'reactive_energy', 'fixed', 'ancillary');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "connectivity_mode" AS ENUM('lte', 'wifi');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "delivery_channel" AS ENUM('app', 'email', 'sms');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "delivery_status" AS ENUM('pending', 'sent', 'failed');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "device_status" AS ENUM('provisioning', 'online', 'offline', 'degraded');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "integrity_status" AS ENUM('clean', 'gaps_present');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "invoice_status" AS ENUM('uploaded', 'parsing', 'parsed_pending_confirm', 'confirmed', 'locked');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "line_category" AS ENUM('active', 'demand', 'reactive', 'fixed', 'vat', 'add_on_metering', 'add_on_admin', 'add_on_vending', 'other');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "rate_unit" AS ENUM('c_per_kwh', 'r_per_kva', 'c_per_kvarh', 'r_per_day', 'r_per_month');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "reading_source" AS ENUM('live', 'backfill_register', 'manual');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "recon_status" AS ENUM('draft', 'final');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "season" AS ENUM('high', 'low', 'all');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "short_month_policy" AS ENUM('clamp_last_day', 'skip', 'rollover');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "site_role" AS ENUM('owner', 'site_manager');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "site_tariff_role" AS ENUM('landlord', 'legal_ceiling');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "tariff_source" AS ENUM('library', 'custom');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "tariff_type" AS ENUM('landlord_stated', 'legal_ceiling');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "tou_period" AS ENUM('peak', 'standard', 'offpeak', 'all');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "ups_status" AS ENUM('on_mains', 'charging', 'on_battery', 'degraded', 'unknown');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "alert_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"alert_id" uuid NOT NULL,
	"channel" "delivery_channel" NOT NULL,
	"recipient_user_id" text,
	"status" "delivery_status" DEFAULT 'pending' NOT NULL,
	"provider_ref" text,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text,
	"site_id" uuid,
	"device_id" uuid,
	"type" "alert_type" NOT NULL,
	"severity" "alert_severity" DEFAULT 'warning' NOT NULL,
	"title" text NOT NULL,
	"message" text,
	"payload" jsonb,
	"status" "alert_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"action" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"diff" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "billing_cycle_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"recurrence" "billing_recurrence" DEFAULT 'calendar_month' NOT NULL,
	"anchor_day" integer,
	"short_month_policy" "short_month_policy" DEFAULT 'clamp_last_day' NOT NULL,
	"interval_count" integer DEFAULT 1 NOT NULL,
	"anchor_date" timestamp with time zone,
	"fiscal_pattern" text DEFAULT '4-4-5',
	"leap_week_placement" text DEFAULT 'last',
	"anchor_time_of_day" text DEFAULT '00:00' NOT NULL,
	"boundary_inclusivity" "boundary_inclusivity" DEFAULT 'half_open' NOT NULL,
	"snap_to_demand_grid" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "billing_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"boundary_inclusivity" "boundary_inclusivity" DEFAULT 'half_open' NOT NULL,
	"demand_interval_minutes" integer NOT NULL,
	"label" text,
	"source" "billing_period_source" DEFAULT 'generated' NOT NULL,
	"policy_id" uuid,
	"status" "billing_period_status" DEFAULT 'open' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "data_gaps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meter_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"gap_start" timestamp with time zone NOT NULL,
	"gap_end" timestamp with time zone NOT NULL,
	"duration_minutes" integer NOT NULL,
	"backfilled" boolean DEFAULT false NOT NULL,
	"backfill_source" text,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "demand_intervals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meter_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"interval_start" timestamp with time zone NOT NULL,
	"interval_minutes" integer NOT NULL,
	"active_energy_kwh" numeric(12, 3),
	"reactive_energy_kvarh" numeric(12, 3),
	"avg_demand_kw" numeric(12, 3),
	"avg_demand_kva" numeric(12, 3),
	"avg_power_factor" numeric(5, 4),
	"sample_count" integer DEFAULT 0 NOT NULL,
	"expected_samples" integer NOT NULL,
	"is_complete" boolean DEFAULT false NOT NULL,
	"source" "reading_source" DEFAULT 'live' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "device_health_samples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"time" timestamp with time zone NOT NULL,
	"connectivity_mode" "connectivity_mode",
	"signal_rssi" integer,
	"ups_status" "ups_status",
	"battery_pct" integer,
	"cpu_temp_c" numeric(5, 2),
	"buffered_records" integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid,
	"serial_number" text NOT NULL,
	"hardware_model" text DEFAULT 'rpi' NOT NULL,
	"sim_iccid" text,
	"sim_msisdn" text,
	"sim_provider" text,
	"connectivity_mode" "connectivity_mode" DEFAULT 'lte' NOT NULL,
	"firmware_version" text,
	"api_key_hash" text NOT NULL,
	"status" "device_status" DEFAULT 'provisioning' NOT NULL,
	"last_seen_at" timestamp with time zone,
	"ups_status" "ups_status" DEFAULT 'unknown' NOT NULL,
	"ups_battery_pct" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "devices_serial_number_unique" UNIQUE("serial_number")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "invoice_line_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"raw_label" text NOT NULL,
	"parsed_category" "line_category" NOT NULL,
	"parsed_value_cents" integer,
	"confidence" numeric(4, 3),
	"confirmed_category" "line_category",
	"confirmed_value_cents" integer,
	"is_impermissible_add_on" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "landlord_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"billing_period_id" uuid,
	"billing_period_start" timestamp with time zone NOT NULL,
	"billing_period_end" timestamp with time zone NOT NULL,
	"file_storage_key" text NOT NULL,
	"file_hash" text NOT NULL,
	"status" "invoice_status" DEFAULT 'uploaded' NOT NULL,
	"parse_model" text,
	"parsed_raw" jsonb,
	"confirmed_active_cents" integer,
	"confirmed_demand_cents" integer,
	"confirmed_reactive_cents" integer,
	"confirmed_fixed_cents" integer,
	"confirmed_total_cents" integer,
	"uploaded_by_user_id" text,
	"confirmed_by_user_id" text,
	"confirmed_at" timestamp with time zone,
	"locked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "meters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"serial_number" text NOT NULL,
	"model" text DEFAULT 'SDM630MCT' NOT NULL,
	"mid_certified_variant" boolean DEFAULT true NOT NULL,
	"mid_certificate_ref" text,
	"ct_ratio_primary" integer,
	"ct_ratio_secondary" integer DEFAULT 5,
	"phase_config" text DEFAULT '3P4W',
	"installed_by_name" text,
	"installer_registration" text,
	"installed_at" timestamp with time zone,
	"commissioned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "readings" (
	"meter_id" uuid NOT NULL,
	"time" timestamp with time zone NOT NULL,
	"seq" bigint,
	"active_energy_kwh" numeric(14, 3),
	"reactive_energy_kvarh" numeric(14, 3),
	"apparent_energy_kvah" numeric(14, 3),
	"total_power_kw" numeric(12, 3),
	"total_apparent_kva" numeric(12, 3),
	"power_factor" numeric(5, 4),
	"source" "reading_source" DEFAULT 'live' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "readings_meter_id_time_pk" PRIMARY KEY("meter_id","time")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reconciliations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"invoice_id" uuid,
	"billing_period_id" uuid,
	"billing_period_start" timestamp with time zone NOT NULL,
	"billing_period_end" timestamp with time zone NOT NULL,
	"boundary_inclusivity" "boundary_inclusivity" DEFAULT 'half_open' NOT NULL,
	"demand_interval_minutes" integer NOT NULL,
	"landlord_tariff_profile_id" uuid,
	"legal_ceiling_tariff_profile_id" uuid,
	"measured_active_kwh" numeric(14, 3),
	"measured_max_demand_kva" numeric(12, 3),
	"measured_reactive_kvarh" numeric(14, 3),
	"expected_landlord_cents" integer,
	"expected_ceiling_cents" integer,
	"charged_total_cents" integer,
	"discrepancy_vs_landlord_cents" integer,
	"discrepancy_vs_ceiling_cents" integer,
	"data_integrity_status" "integrity_status" DEFAULT 'clean' NOT NULL,
	"gap_count" integer DEFAULT 0 NOT NULL,
	"gap_minutes_total" integer DEFAULT 0 NOT NULL,
	"breakdown" jsonb,
	"status" "recon_status" DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"pdf_storage_key" text,
	"pdf_hash" text,
	"generated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "site_access" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" "site_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "site_tariff_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"tariff_profile_id" uuid NOT NULL,
	"role" "site_tariff_role" NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"address_line1" text,
	"city" text,
	"province" text,
	"supply_zone" text,
	"timezone" text DEFAULT 'Africa/Johannesburg' NOT NULL,
	"demand_interval_minutes" integer DEFAULT 30 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tariff_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text,
	"name" text NOT NULL,
	"type" "tariff_type" NOT NULL,
	"source" "tariff_source" NOT NULL,
	"supply_zone" text,
	"distributor" text,
	"currency" text DEFAULT 'ZAR' NOT NULL,
	"tou_schedule" jsonb,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"validated_by_attorney" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tariff_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tariff_profile_id" uuid NOT NULL,
	"charge_type" "charge_type" NOT NULL,
	"unit" "rate_unit" NOT NULL,
	"rate_value" numeric(14, 6) NOT NULL,
	"season" "season" DEFAULT 'all' NOT NULL,
	"tou_period" "tou_period" DEFAULT 'all' NOT NULL,
	"block_threshold_kwh" numeric(12, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "alert_deliv_idx" ON "alert_deliveries" ("alert_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "alerts_org_idx" ON "alerts" ("organization_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_entity_idx" ON "audit_log" ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_policy_site_idx" ON "billing_cycle_policies" ("site_id","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "billing_period_uq" ON "billing_periods" ("site_id","period_start");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "data_gaps_site_idx" ON "data_gaps" ("site_id","gap_start");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "demand_interval_uq" ON "demand_intervals" ("meter_id","interval_start","interval_minutes");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "demand_site_time_idx" ON "demand_intervals" ("site_id","interval_start");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dev_health_idx" ON "device_health_samples" ("device_id","time");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "devices_site_idx" ON "devices" ("site_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "line_items_invoice_idx" ON "invoice_line_items" ("invoice_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoices_site_idx" ON "landlord_invoices" ("site_id","billing_period_start");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "meters_device_idx" ON "meters" ("device_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "readings_time_idx" ON "readings" ("time");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recon_site_idx" ON "reconciliations" ("site_id","billing_period_start");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "site_access_uq" ON "site_access" ("site_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "site_tariff_idx" ON "site_tariff_assignments" ("site_id","role");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sites_org_idx" ON "sites" ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tariff_lib_idx" ON "tariff_profiles" ("type","supply_zone");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tariff_rates_profile_idx" ON "tariff_rates" ("tariff_profile_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "alert_deliveries" ADD CONSTRAINT "alert_deliveries_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "alerts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "alerts" ADD CONSTRAINT "alerts_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "alerts" ADD CONSTRAINT "alerts_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "billing_cycle_policies" ADD CONSTRAINT "billing_cycle_policies_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "billing_periods" ADD CONSTRAINT "billing_periods_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "billing_periods" ADD CONSTRAINT "billing_periods_policy_id_billing_cycle_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "billing_cycle_policies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "data_gaps" ADD CONSTRAINT "data_gaps_meter_id_meters_id_fk" FOREIGN KEY ("meter_id") REFERENCES "meters"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "data_gaps" ADD CONSTRAINT "data_gaps_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "demand_intervals" ADD CONSTRAINT "demand_intervals_meter_id_meters_id_fk" FOREIGN KEY ("meter_id") REFERENCES "meters"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "demand_intervals" ADD CONSTRAINT "demand_intervals_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "device_health_samples" ADD CONSTRAINT "device_health_samples_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "devices" ADD CONSTRAINT "devices_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_invoice_id_landlord_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "landlord_invoices"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "landlord_invoices" ADD CONSTRAINT "landlord_invoices_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "landlord_invoices" ADD CONSTRAINT "landlord_invoices_billing_period_id_billing_periods_id_fk" FOREIGN KEY ("billing_period_id") REFERENCES "billing_periods"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "meters" ADD CONSTRAINT "meters_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "meters" ADD CONSTRAINT "meters_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "readings" ADD CONSTRAINT "readings_meter_id_meters_id_fk" FOREIGN KEY ("meter_id") REFERENCES "meters"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_invoice_id_landlord_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "landlord_invoices"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_billing_period_id_billing_periods_id_fk" FOREIGN KEY ("billing_period_id") REFERENCES "billing_periods"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_landlord_tariff_profile_id_tariff_profiles_id_fk" FOREIGN KEY ("landlord_tariff_profile_id") REFERENCES "tariff_profiles"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_legal_ceiling_tariff_profile_id_tariff_profiles_id_fk" FOREIGN KEY ("legal_ceiling_tariff_profile_id") REFERENCES "tariff_profiles"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "site_access" ADD CONSTRAINT "site_access_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "site_tariff_assignments" ADD CONSTRAINT "site_tariff_assignments_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "site_tariff_assignments" ADD CONSTRAINT "site_tariff_assignments_tariff_profile_id_tariff_profiles_id_fk" FOREIGN KEY ("tariff_profile_id") REFERENCES "tariff_profiles"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tariff_rates" ADD CONSTRAINT "tariff_rates_tariff_profile_id_tariff_profiles_id_fk" FOREIGN KEY ("tariff_profile_id") REFERENCES "tariff_profiles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
