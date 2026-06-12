CREATE TYPE "public"."milestone_status" AS ENUM('pending', 'in_progress', 'done');--> statement-breakpoint
CREATE TABLE "milestone_dependencies" (
	"milestone_id" uuid NOT NULL,
	"depends_on_id" uuid NOT NULL,
	CONSTRAINT "milestone_dependencies_milestone_id_depends_on_id_pk" PRIMARY KEY("milestone_id","depends_on_id")
);
--> statement-breakpoint
CREATE TABLE "milestones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"study_id" uuid,
	"title" text NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"owner_id" uuid,
	"starts_on" date,
	"due_on" date,
	"status" "milestone_status" DEFAULT 'pending' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "milestone_dependencies" ADD CONSTRAINT "milestone_dependencies_milestone_id_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."milestones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestone_dependencies" ADD CONSTRAINT "milestone_dependencies_depends_on_id_milestones_id_fk" FOREIGN KEY ("depends_on_id") REFERENCES "public"."milestones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_study_id_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."studies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_owner_id_members_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_created_by_members_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "milestones_project_idx" ON "milestones" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "milestones_study_idx" ON "milestones" USING btree ("study_id");