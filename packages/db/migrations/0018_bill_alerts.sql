-- Live current-bill alerts: notify a site's recipients when the running estimate
-- crosses a Rand threshold. Config lives on the site; `basis` picks charges-so-far
-- vs projected period-end; last-fired period dedupes to one alert per billing cycle.
-- Additive + idempotent — safe to apply out-of-band.
ALTER TABLE "sites"
  ADD COLUMN IF NOT EXISTS "bill_alert_threshold_cents" integer,
  ADD COLUMN IF NOT EXISTS "bill_alert_basis" text NOT NULL DEFAULT 'actual',
  ADD COLUMN IF NOT EXISTS "bill_alert_last_fired_period_start" timestamptz;

-- New alert type for the in-app inbox / dispatch.
ALTER TYPE "alert_type" ADD VALUE IF NOT EXISTS 'bill_threshold';
