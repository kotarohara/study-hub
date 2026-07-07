CREATE TYPE "public"."compensation_method" AS ENUM('paynow', 'paypal', 'prolific', 'cash', 'voucher');--> statement-breakpoint
CREATE TYPE "public"."compensation_status" AS ENUM('pending', 'approved', 'paid');--> statement-breakpoint
CREATE TABLE "compensations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'SGD' NOT NULL,
	"scheme" text DEFAULT '' NOT NULL,
	"method" "compensation_method" NOT NULL,
	"status" "compensation_status" DEFAULT 'pending' NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"paid_by" uuid,
	"paid_at" timestamp with time zone,
	"reference" text DEFAULT '' NOT NULL,
	"prolific_submission_id" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "compensations" ADD CONSTRAINT "compensations_enrollment_id_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compensations" ADD CONSTRAINT "compensations_approved_by_members_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compensations" ADD CONSTRAINT "compensations_paid_by_members_id_fk" FOREIGN KEY ("paid_by") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compensations" ADD CONSTRAINT "compensations_created_by_members_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "compensations_enrollment_idx" ON "compensations" USING btree ("enrollment_id");--> statement-breakpoint
CREATE INDEX "compensations_status_idx" ON "compensations" USING btree ("status");