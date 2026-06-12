CREATE TYPE "public"."design_type" AS ENUM('between', 'within', 'mixed');--> statement-breakpoint
CREATE TABLE "conditions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"study_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conditions_study_name_unique" UNIQUE("study_id","name")
);
--> statement-breakpoint
ALTER TABLE "studies" ADD COLUMN "research_questions" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "studies" ADD COLUMN "hypotheses" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "studies" ADD COLUMN "independent_variables" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "studies" ADD COLUMN "dependent_variables" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "studies" ADD COLUMN "design_type" "design_type";--> statement-breakpoint
ALTER TABLE "studies" ADD COLUMN "target_n" integer;--> statement-breakpoint
ALTER TABLE "studies" ADD COLUMN "exclusion_criteria" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "studies" ADD COLUMN "counterbalancing_scheme" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "conditions" ADD CONSTRAINT "conditions_study_id_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."studies"("id") ON DELETE cascade ON UPDATE no action;