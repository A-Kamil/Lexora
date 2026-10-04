CREATE TYPE "public"."analysis_status" AS ENUM('ok', 'fallback');--> statement-breakpoint
CREATE TYPE "public"."case_member_role" AS ENUM('client', 'lawyer');--> statement-breakpoint
CREATE TYPE "public"."case_status" AS ENUM('open', 'closed');--> statement-breakpoint
CREATE TYPE "public"."conversation_channel" AS ENUM('whatsapp', 'voice');--> statement-breakpoint
CREATE TYPE "public"."conversation_status" AS ENUM('open', 'completing', 'complete');--> statement-breakpoint
CREATE TYPE "public"."delivery_status" AS ENUM('none', 'pending', 'sending', 'accepted', 'delivered', 'failed', 'delivery_unknown', 'simulated');--> statement-breakpoint
CREATE TYPE "public"."document_status" AS ENUM('pending', 'stored', 'extracting', 'ready', 'rejected', 'failed');--> statement-breakpoint
CREATE TYPE "public"."escalation_status" AS ENUM('pending', 'sending', 'accepted', 'delivered', 'failed', 'delivery_unknown', 'blocked_no_lawyer', 'blocked_template_required', 'simulated');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "public"."message_kind" AS ENUM('text', 'media', 'system');--> statement-breakpoint
CREATE TYPE "public"."person_role" AS ENUM('client', 'lawyer');--> statement-breakpoint
CREATE TYPE "public"."verification_status" AS ENUM('unverified', 'confirmed');--> statement-breakpoint
CREATE TABLE "analyses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"trigger_key" text NOT NULL,
	"result" jsonb NOT NULL,
	"status" "analysis_status" NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"schema_version" integer NOT NULL,
	"context_message_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"context_document_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analyses_trigger_key_key" UNIQUE("trigger_key"),
	CONSTRAINT "analyses_id_case_id_key" UNIQUE("id","case_id"),
	CONSTRAINT "analyses_trigger_key_not_blank" CHECK (length(btrim("analyses"."trigger_key")) > 0),
	CONSTRAINT "analyses_schema_version_positive" CHECK ("analyses"."schema_version" > 0),
	CONSTRAINT "analyses_model_not_blank" CHECK (length(btrim("analyses"."model")) > 0),
	CONSTRAINT "analyses_prompt_version_not_blank" CHECK (length(btrim("analyses"."prompt_version")) > 0)
);
--> statement-breakpoint
CREATE TABLE "case_members" (
	"case_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"role" "case_member_role" NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "case_members_pkey" PRIMARY KEY("case_id","person_id")
);
--> statement-breakpoint
CREATE TABLE "cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"status" "case_status" DEFAULT 'open' NOT NULL,
	"jurisdiction" text NOT NULL,
	"language" text NOT NULL,
	"timezone" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cases_title_not_blank" CHECK (length(btrim("cases"."title")) > 0),
	CONSTRAINT "cases_jurisdiction_not_blank" CHECK (length(btrim("cases"."jurisdiction")) > 0),
	CONSTRAINT "cases_language_not_blank" CHECK (length(btrim("cases"."language")) > 0),
	CONSTRAINT "cases_timezone_not_blank" CHECK (length(btrim("cases"."timezone")) > 0)
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"channel" "conversation_channel" NOT NULL,
	"provider_session_key" text,
	"status" "conversation_status" DEFAULT 'open' NOT NULL,
	"summary" text,
	"summary_through_message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_provider_session_key_key" UNIQUE("provider_session_key"),
	CONSTRAINT "conversations_id_case_id_key" UNIQUE("id","case_id"),
	CONSTRAINT "conversations_provider_session_key_not_blank" CHECK ("conversations"."provider_session_key" IS NULL OR length(btrim("conversations"."provider_session_key")) > 0),
	CONSTRAINT "conversations_summary_requires_cutoff" CHECK ("conversations"."summary" IS NULL OR "conversations"."summary_through_message_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "deadlines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"title" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"timezone" text NOT NULL,
	"source_document_id" uuid,
	"source_message_id" uuid,
	"verification_status" "verification_status" DEFAULT 'unverified' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deadlines_title_not_blank" CHECK (length(btrim("deadlines"."title")) > 0),
	CONSTRAINT "deadlines_timezone_not_blank" CHECK (length(btrim("deadlines"."timezone")) > 0)
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"media_index" integer NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" bigint,
	"sha256" text,
	"status" "document_status" DEFAULT 'pending' NOT NULL,
	"extracted_text" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_message_id_media_index_key" UNIQUE("message_id","media_index"),
	CONSTRAINT "documents_storage_key_key" UNIQUE("storage_key"),
	CONSTRAINT "documents_id_case_id_key" UNIQUE("id","case_id"),
	CONSTRAINT "documents_media_index_non_negative" CHECK ("documents"."media_index" >= 0),
	CONSTRAINT "documents_storage_key_not_blank" CHECK (length(btrim("documents"."storage_key")) > 0),
	CONSTRAINT "documents_mime_type_not_blank" CHECK (length(btrim("documents"."mime_type")) > 0),
	CONSTRAINT "documents_stored_has_bytes" CHECK ("documents"."status" NOT IN ('stored', 'extracting', 'ready') OR ("documents"."byte_size" IS NOT NULL AND "documents"."sha256" IS NOT NULL)),
	CONSTRAINT "documents_ready_has_text" CHECK ("documents"."status" <> 'ready' OR "documents"."extracted_text" IS NOT NULL),
	CONSTRAINT "documents_terminal_has_reason" CHECK ("documents"."status" NOT IN ('rejected', 'failed') OR length(btrim(coalesce("documents"."error_code", ''))) > 0),
	CONSTRAINT "documents_error_code_not_blank" CHECK ("documents"."error_code" IS NULL OR length(btrim("documents"."error_code")) > 0),
	CONSTRAINT "documents_byte_size_non_negative" CHECK ("documents"."byte_size" IS NULL OR "documents"."byte_size" >= 0)
);
--> statement-breakpoint
CREATE TABLE "escalations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"analysis_id" uuid NOT NULL,
	"lawyer_id" uuid,
	"outbound_message_id" uuid,
	"status" "escalation_status" DEFAULT 'pending' NOT NULL,
	"reason" text NOT NULL,
	"provider_message_id" text,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "escalations_analysis_id_key" UNIQUE("analysis_id"),
	CONSTRAINT "escalations_reason_not_blank" CHECK (length(btrim("escalations"."reason")) > 0),
	CONSTRAINT "escalations_blocked_no_lawyer_has_no_lawyer" CHECK ("escalations"."status" <> 'blocked_no_lawyer' OR "escalations"."lawyer_id" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"person_id" uuid,
	"direction" "message_direction" NOT NULL,
	"kind" "message_kind" NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"provider" text,
	"provider_message_id" text,
	"idempotency_key" text,
	"delivery_status" "delivery_status" DEFAULT 'none' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_id_case_id_key" UNIQUE("id","case_id"),
	CONSTRAINT "messages_inbound_has_no_delivery" CHECK ("messages"."direction" = 'outbound' OR "messages"."delivery_status" = 'none'),
	CONSTRAINT "messages_provider_not_blank" CHECK ("messages"."provider" IS NULL OR length(btrim("messages"."provider")) > 0),
	CONSTRAINT "messages_provider_message_id_not_blank" CHECK ("messages"."provider_message_id" IS NULL OR length(btrim("messages"."provider_message_id")) > 0),
	CONSTRAINT "messages_idempotency_key_not_blank" CHECK ("messages"."idempotency_key" IS NULL OR length(btrim("messages"."idempotency_key")) > 0)
);
--> statement-breakpoint
CREATE TABLE "people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" text NOT NULL,
	"phone_e164" text NOT NULL,
	"role" "person_role" NOT NULL,
	"enrolled_at" timestamp with time zone,
	"last_whatsapp_inbound_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "people_phone_e164_key" UNIQUE("phone_e164"),
	CONSTRAINT "people_phone_e164_is_e164" CHECK ("people"."phone_e164" ~ '^\+[1-9][0-9]{6,14}$'),
	CONSTRAINT "people_display_name_not_blank" CHECK (length(btrim("people"."display_name")) > 0)
);
--> statement-breakpoint
ALTER TABLE "analyses" ADD CONSTRAINT "analyses_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analyses" ADD CONSTRAINT "analyses_conversation_case_fkey" FOREIGN KEY ("conversation_id","case_id") REFERENCES "public"."conversations"("id","case_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_members" ADD CONSTRAINT "case_members_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_members" ADD CONSTRAINT "case_members_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_summary_through_message_id_messages_id_fk" FOREIGN KEY ("summary_through_message_id") REFERENCES "public"."messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_case_member_fkey" FOREIGN KEY ("case_id","person_id") REFERENCES "public"."case_members"("case_id","person_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deadlines" ADD CONSTRAINT "deadlines_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deadlines" ADD CONSTRAINT "deadlines_source_document_case_fkey" FOREIGN KEY ("source_document_id","case_id") REFERENCES "public"."documents"("id","case_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deadlines" ADD CONSTRAINT "deadlines_source_message_case_fkey" FOREIGN KEY ("source_message_id","case_id") REFERENCES "public"."messages"("id","case_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_message_case_fkey" FOREIGN KEY ("message_id","case_id") REFERENCES "public"."messages"("id","case_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_analysis_case_fkey" FOREIGN KEY ("analysis_id","case_id") REFERENCES "public"."analyses"("id","case_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_lawyer_case_member_fkey" FOREIGN KEY ("case_id","lawyer_id") REFERENCES "public"."case_members"("case_id","person_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_outbound_message_case_fkey" FOREIGN KEY ("outbound_message_id","case_id") REFERENCES "public"."messages"("id","case_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_case_fkey" FOREIGN KEY ("conversation_id","case_id") REFERENCES "public"."conversations"("id","case_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_case_member_fkey" FOREIGN KEY ("case_id","person_id") REFERENCES "public"."case_members"("case_id","person_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "analyses_case_created_at_idx" ON "analyses" USING btree ("case_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "case_members_one_primary_lawyer_idx" ON "case_members" USING btree ("case_id") WHERE "case_members"."role" = 'lawyer' AND "case_members"."is_primary";--> statement-breakpoint
CREATE INDEX "case_members_person_id_idx" ON "case_members" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_one_open_whatsapp_idx" ON "conversations" USING btree ("case_id","person_id") WHERE "conversations"."channel" = 'whatsapp' AND "conversations"."status" = 'open';--> statement-breakpoint
CREATE INDEX "conversations_case_id_idx" ON "conversations" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "deadlines_case_due_at_idx" ON "deadlines" USING btree ("case_id","due_at","id");--> statement-breakpoint
CREATE INDEX "documents_case_id_status_idx" ON "documents" USING btree ("case_id","status");--> statement-breakpoint
CREATE INDEX "escalations_case_created_at_idx" ON "escalations" USING btree ("case_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "messages_provider_message_id_idx" ON "messages" USING btree ("provider","provider_message_id") WHERE "messages"."provider" IS NOT NULL AND "messages"."provider_message_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_conversation_idempotency_key_idx" ON "messages" USING btree ("conversation_id","idempotency_key") WHERE "messages"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "messages_conversation_chronology_idx" ON "messages" USING btree ("conversation_id","created_at","id");--> statement-breakpoint
CREATE INDEX "messages_case_chronology_idx" ON "messages" USING btree ("case_id","created_at","id");