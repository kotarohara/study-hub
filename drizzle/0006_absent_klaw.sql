CREATE TYPE "public"."assignment_strategy" AS ENUM('random_balanced', 'manual_sequence');--> statement-breakpoint
ALTER TABLE "studies" ADD COLUMN "assignment_strategy" "assignment_strategy" DEFAULT 'random_balanced' NOT NULL;--> statement-breakpoint
ALTER TABLE "studies" ADD COLUMN "assignment_sequence" text DEFAULT '' NOT NULL;