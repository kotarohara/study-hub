ALTER TABLE "consents" DROP CONSTRAINT "consents_document_id_documents_id_fk";
--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;