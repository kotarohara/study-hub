ALTER TABLE "document_versions" ADD COLUMN "external_url" text;--> statement-breakpoint
ALTER TABLE "studies" ADD COLUMN "notion_page_id" text DEFAULT '' NOT NULL;