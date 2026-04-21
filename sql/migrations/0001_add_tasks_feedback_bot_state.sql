CREATE TABLE "bot_user_state" (
	"telegram_user_id" bigint PRIMARY KEY NOT NULL,
	"active_project_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"query" text NOT NULL,
	"query_surface" text NOT NULL,
	"query_project_id" text,
	"mode" text NOT NULL,
	"limit" integer NOT NULL,
	"result_ids" uuid[] NOT NULL,
	"result_project_ids" text[] NOT NULL,
	"rank_positions" integer[] NOT NULL,
	"scores" real[],
	"selected_id" uuid,
	"selected_rank" integer,
	"thumbs" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_feedback_surface_check" CHECK ("search_feedback"."query_surface" IN ('telegram','mcp','http')),
	CONSTRAINT "search_feedback_mode_check" CHECK ("search_feedback"."mode" IN ('keyword','semantic','hybrid')),
	CONSTRAINT "search_feedback_thumbs_check" CHECK ("search_feedback"."thumbs" IS NULL OR "search_feedback"."thumbs" IN ('up','down'))
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" text NOT NULL,
	"project_path" text,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'open' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"due_date" timestamp with time zone,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"source_ref" text,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "tasks_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "tasks_title_length_check" CHECK (char_length("tasks"."title") BETWEEN 1 AND 500),
	CONSTRAINT "tasks_status_check" CHECK ("tasks"."status" IN ('open','in_progress','done','cancelled')),
	CONSTRAINT "tasks_priority_check" CHECK ("tasks"."priority" IN ('low','normal','high')),
	CONSTRAINT "tasks_source_check" CHECK ("tasks"."source" IN ('manual','telegram','claude-code','codex','mcp'))
);
--> statement-breakpoint
CREATE INDEX "search_feedback_created_idx" ON "search_feedback" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "search_feedback_mode_idx" ON "search_feedback" USING btree ("mode","thumbs");--> statement-breakpoint
CREATE INDEX "tasks_project_status_created_idx" ON "tasks" USING btree ("project_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "tasks_due_date_idx" ON "tasks" USING btree ("due_date") WHERE "tasks"."due_date" IS NOT NULL AND "tasks"."status" <> 'done';--> statement-breakpoint
CREATE INDEX "tasks_idempotency_idx" ON "tasks" USING btree ("idempotency_key") WHERE "tasks"."idempotency_key" IS NOT NULL;