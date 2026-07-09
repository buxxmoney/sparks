-- Customer confirmation alert when a bill is sent to Sparks for review. Additive.

ALTER TYPE "alert_type" ADD VALUE IF NOT EXISTS 'review_submitted';
