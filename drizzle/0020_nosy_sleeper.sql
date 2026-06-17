CREATE TYPE "public"."diary_prompt_status" AS ENUM('scheduled', 'sent', 'answered', 'missed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."diary_window_type" AS ENUM('fixed', 'interval', 'randomized');--> statement-breakpoint
CREATE TABLE "diary_prompts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schedule_id" uuid NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"study_id" uuid NOT NULL,
	"prompt_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" "diary_prompt_status" DEFAULT 'scheduled' NOT NULL,
	"is_pilot" boolean DEFAULT false NOT NULL,
	"sent_at" timestamp with time zone,
	"answered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "diary_prompts_window_unique" UNIQUE("schedule_id","enrollment_id","prompt_at")
);
--> statement-breakpoint
CREATE TABLE "diary_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prompt_id" uuid NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"instrument_version_number" integer NOT NULL,
	"answers" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "diary_responses_prompt_id_unique" UNIQUE("prompt_id")
);
--> statement-breakpoint
CREATE TABLE "diary_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"study_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"instrument_version_number" integer NOT NULL,
	"window_type" "diary_window_type" NOT NULL,
	"config" jsonb NOT NULL,
	"duration_days" integer NOT NULL,
	"expiry_minutes" integer NOT NULL,
	"quick_reply" boolean DEFAULT false NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "diary_schedules_study_id_unique" UNIQUE("study_id")
);
--> statement-breakpoint
ALTER TABLE "diary_prompts" ADD CONSTRAINT "diary_prompts_schedule_id_diary_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."diary_schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diary_prompts" ADD CONSTRAINT "diary_prompts_enrollment_id_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diary_prompts" ADD CONSTRAINT "diary_prompts_study_id_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."studies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diary_responses" ADD CONSTRAINT "diary_responses_prompt_id_diary_prompts_id_fk" FOREIGN KEY ("prompt_id") REFERENCES "public"."diary_prompts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diary_responses" ADD CONSTRAINT "diary_responses_enrollment_id_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diary_schedules" ADD CONSTRAINT "diary_schedules_study_id_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."studies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diary_schedules" ADD CONSTRAINT "diary_schedules_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diary_schedules" ADD CONSTRAINT "diary_schedules_created_by_members_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "diary_prompts_due_idx" ON "diary_prompts" USING btree ("status","prompt_at");--> statement-breakpoint
CREATE INDEX "diary_prompts_enrollment_idx" ON "diary_prompts" USING btree ("enrollment_id");