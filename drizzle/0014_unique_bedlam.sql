CREATE TABLE "consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"document_version_number" integer NOT NULL,
	"signature_name" text NOT NULL,
	"consent_to_recontact" boolean DEFAULT false NOT NULL,
	"signed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consents_enrollment_version_unique" UNIQUE("enrollment_id","document_id","document_version_number")
);
--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_enrollment_id_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "consents_enrollment_idx" ON "consents" USING btree ("enrollment_id");