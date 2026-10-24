-- Stripe payments: bookings start PENDING with a payment window, and are
-- confirmed only by a verified Stripe webhook (or worker reconciliation).
ALTER TYPE "BookingStatus" ADD VALUE 'EXPIRED';

ALTER TABLE "bookings" ADD COLUMN "expires_at" TIMESTAMP(3);
CREATE INDEX "bookings_status_expires_at_idx" ON "bookings"("status", "expires_at");

ALTER TABLE "payments" ALTER COLUMN "transaction_ref" DROP NOT NULL;
ALTER TABLE "payments" ALTER COLUMN "provider" SET DEFAULT 'STRIPE';
CREATE UNIQUE INDEX "payments_transaction_ref_key" ON "payments"("transaction_ref");

CREATE TABLE "stripe_events" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "stripe_events_pkey" PRIMARY KEY ("id")
);
