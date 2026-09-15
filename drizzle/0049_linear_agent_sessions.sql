CREATE TABLE "linear_agent_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"linear_connection_id" uuid NOT NULL,
	"linear_organization_id" text NOT NULL,
	"linear_session_id" text NOT NULL,
	"issue_id" text NOT NULL,
	"issue_identifier" text,
	"team_id" text NOT NULL,
	"project_id" uuid,
	"agent_session_id" uuid,
	"current_execution_id" uuid,
	"daemon_id" uuid,
	"daemon_agent_id" text,
	"daemon_workspace_id" text,
	"mirror_status" text DEFAULT 'pending' NOT NULL,
	"responded_at" timestamp with time zone,
	"last_activity_id" text,
	"last_activity_at" timestamp with time zone,
	"last_assistant_message" text,
	"pull_request_url" text,
	"pending_permission" jsonb,
	"pending_prompts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"stop_requested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "linear_agent_sessions_mirror_status_check" CHECK ("linear_agent_sessions"."mirror_status" in ('pending', 'active', 'awaitingInput', 'complete', 'error', 'stale'))
);
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "workspace_key" text;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "linear_connections" ADD COLUMN "team_access" jsonb;--> statement-breakpoint
ALTER TABLE "linear_agent_sessions" ADD CONSTRAINT "linear_agent_sessions_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linear_agent_sessions" ADD CONSTRAINT "linear_agent_sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linear_agent_sessions" ADD CONSTRAINT "linear_agent_sessions_agent_session_id_agent_sessions_id_fk" FOREIGN KEY ("agent_session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linear_agent_sessions" ADD CONSTRAINT "linear_agent_sessions_current_execution_id_agent_executions_id_fk" FOREIGN KEY ("current_execution_id") REFERENCES "public"."agent_executions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linear_agent_sessions" ADD CONSTRAINT "linear_agent_sessions_connection_organization_fk" FOREIGN KEY ("linear_connection_id","organization_id") REFERENCES "public"."linear_connections"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "linear_agent_sessions_linear_session_unique" ON "linear_agent_sessions" USING btree ("linear_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "linear_agent_sessions_id_organization_unique" ON "linear_agent_sessions" USING btree ("id","organization_id");--> statement-breakpoint
CREATE INDEX "linear_agent_sessions_organization_issue_idx" ON "linear_agent_sessions" USING btree ("organization_id","issue_id");--> statement-breakpoint
CREATE INDEX "linear_agent_sessions_agent_session_idx" ON "linear_agent_sessions" USING btree ("agent_session_id");--> statement-breakpoint
CREATE INDEX "linear_agent_sessions_current_execution_idx" ON "linear_agent_sessions" USING btree ("current_execution_id");--> statement-breakpoint
CREATE INDEX "agent_sessions_project_workspace_key_idx" ON "agent_sessions" USING btree ("project_id","workspace_key");