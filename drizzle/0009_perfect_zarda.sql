ALTER TABLE "studies" ADD COLUMN "irb_protocol_number" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "studies" ADD COLUMN "irb_approved_on" date;--> statement-breakpoint
ALTER TABLE "studies" ADD COLUMN "irb_expires_on" date;