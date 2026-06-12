CREATE TYPE "public"."oversight_pathway" AS ENUM('irb_reviewed', 'irb_exempt', 'internal_pilot');--> statement-breakpoint
CREATE TYPE "public"."study_methodology" AS ENUM('survey', 'crowdsourcing', 'lab_experiment', 'diary_study', 'interview', 'field_deployment');--> statement-breakpoint
CREATE TYPE "public"."study_status" AS ENUM('draft', 'irb_review', 'recruiting', 'running', 'analysis', 'archived');--> statement-breakpoint
CREATE TABLE "studies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"methodology" "study_methodology" NOT NULL,
	"status" "study_status" DEFAULT 'draft' NOT NULL,
	"oversight_pathway" "oversight_pathway" DEFAULT 'irb_reviewed' NOT NULL,
	"archived_from" "study_status",
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "studies" ADD CONSTRAINT "studies_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studies" ADD CONSTRAINT "studies_created_by_members_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;