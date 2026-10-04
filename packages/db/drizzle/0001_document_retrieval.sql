CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE "documents"
  ADD COLUMN "original_bytes" bytea,
  ADD COLUMN "original_filename" text,
  ADD COLUMN "indexed_at" timestamp with time zone,
  ADD COLUMN "embedding_error" text;

CREATE TABLE "document_chunks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "document_id" uuid NOT NULL,
  "chunk_index" integer NOT NULL,
  "content" text NOT NULL,
  "embedding" vector(1024) NOT NULL,
  "embedding_model" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "document_chunks_document_id_chunk_index_key" UNIQUE("document_id", "chunk_index"),
  CONSTRAINT "document_chunks_chunk_index_non_negative" CHECK ("document_chunks"."chunk_index" >= 0),
  CONSTRAINT "document_chunks_content_not_blank" CHECK (length(btrim("document_chunks"."content")) > 0),
  CONSTRAINT "document_chunks_embedding_model_not_blank" CHECK (length(btrim("document_chunks"."embedding_model")) > 0)
);

ALTER TABLE "document_chunks"
  ADD CONSTRAINT "document_chunks_document_id_fkey"
  FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

CREATE INDEX "document_chunks_document_id_idx" ON "document_chunks" USING btree ("document_id");
