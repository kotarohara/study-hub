CREATE TYPE "public"."enrollment_status" AS ENUM('screened', 'eligible', 'consented', 'active', 'completed', 'withdrawn', 'excluded');--> statement-breakpoint
CREATE TYPE "public"."screener_status" AS ENUM('open', 'paused');--> statement-breakpoint
CREATE TABLE "enrollments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"study_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"status" "enrollment_status" DEFAULT 'screened' NOT NULL,
	"is_pilot" boolean DEFAULT false NOT NULL,
	"condition_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enrollments_study_participant_unique" UNIQUE("study_id","participant_id")
);
--> statement-breakpoint
CREATE TABLE "screener_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"screener_id" uuid NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"instrument_version_number" integer NOT NULL,
	"answers" jsonb NOT NULL,
	"eligible" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "screeners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"study_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"instrument_version_number" integer NOT NULL,
	"eligibility" jsonb NOT NULL,
	"status" "screener_status" DEFAULT 'open' NOT NULL,
	"token" text NOT NULL,
	"views" integer DEFAULT 0 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "screeners_study_id_unique" UNIQUE("study_id"),
	CONSTRAINT "screeners_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "participants" ALTER COLUMN "created_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_study_id_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."studies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_condition_id_conditions_id_fk" FOREIGN KEY ("condition_id") REFERENCES "public"."conditions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screener_responses" ADD CONSTRAINT "screener_responses_screener_id_screeners_id_fk" FOREIGN KEY ("screener_id") REFERENCES "public"."screeners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screener_responses" ADD CONSTRAINT "screener_responses_enrollment_id_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screeners" ADD CONSTRAINT "screeners_study_id_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."studies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screeners" ADD CONSTRAINT "screeners_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screeners" ADD CONSTRAINT "screeners_created_by_members_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;