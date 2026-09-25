-- Schema-only test baseline; no production rows. Supabase platform schemas are supplied by the local harness.
BEGIN;

SET LOCAL statement_timeout = '0';

SET LOCAL lock_timeout = '10s';

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;

DO $$ BEGIN CREATE TYPE public."app_role" AS ENUM ('Owner', 'Manager', 'Account Manager', 'Project Manager', 'Designer', 'Content Creator', 'Media Buyer', 'Finance', 'Sales', 'Viewer'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE public."user_status" AS ENUM ('Active', 'Inactive'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE SEQUENCE IF NOT EXISTS public."permissions_id_seq";

CREATE SEQUENCE IF NOT EXISTS public."workflow_steps_id_seq";


CREATE TABLE IF NOT EXISTS public."activity_logs" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "data" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "actor" uuid DEFAULT auth.uid(),
  "entity_type" text,
  "entity_id" text,
  "action" text,
  "created_at" timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public."approvals" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "data" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "entity_type" text,
  "entity_id" text,
  "status" text,
  "reviewed_by" uuid,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public."assets" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "data" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "client_id" uuid,
  "visibility" text,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public."client_assignments" (
  "client_id" uuid NOT NULL,
  "user_id" uuid NOT NULL
);

CREATE TABLE IF NOT EXISTS public."clients" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "data" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "account_manager" uuid,
  "brand" text,
  "status" text,
  "name" text,
  "created_by" uuid DEFAULT auth.uid(),
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public."comments" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "data" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "entity_type" text,
  "entity_id" text,
  "client_id" uuid,
  "visibility" text DEFAULT 'Internal Only'::text,
  "author" uuid DEFAULT auth.uid(),
  "created_at" timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public."employees" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "data" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public."invoices" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "data" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "client_id" uuid,
  "status" text,
  "currency" text,
  "amount" numeric,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public."migration_audit" (
  "id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  "migration" text NOT NULL,
  "applied_at" timestamp with time zone DEFAULT now() NOT NULL,
  "note" text
);

CREATE TABLE IF NOT EXISTS public."notifications" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "data" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "user_id" uuid,
  "role" app_role,
  "read" boolean DEFAULT false,
  "created_at" timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public."permissions" (
  "id" bigint DEFAULT nextval('permissions_id_seq'::regclass) NOT NULL,
  "role" app_role NOT NULL,
  "module" text NOT NULL,
  "action" text NOT NULL
);

CREATE TABLE IF NOT EXISTS public."profiles" (
  "id" uuid NOT NULL,
  "full_name" text,
  "username" text,
  "email" text,
  "phone" text,
  "job_title" text,
  "role" app_role DEFAULT 'Viewer'::app_role NOT NULL,
  "status" user_status DEFAULT 'Active'::user_status NOT NULL,
  "data_scope" text DEFAULT 'assigned'::text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_login" timestamp with time zone,
  "client_id" text,
  "employee_id" text
);

CREATE TABLE IF NOT EXISTS public."proposals" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "data" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "client_id" uuid,
  "status" text,
  "currency" text,
  "created_by" uuid DEFAULT auth.uid(),
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public."records" (
  "id" text NOT NULL,
  "coll" text NOT NULL,
  "data" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone,
  "created_by" text,
  "updated_by" text,
  "deleted_at" timestamp with time zone
);





CREATE TABLE IF NOT EXISTS public."requests" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "data" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "requested_by" uuid DEFAULT auth.uid(),
  "assigned_manager" uuid,
  "status" text,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public."roles" (
  "role" app_role NOT NULL,
  "description" text
);

CREATE TABLE IF NOT EXISTS public."settings" (
  "id" text NOT NULL,
  "data" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public."tasks" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "data" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "client_id" uuid,
  "assigned_to" uuid,
  "status" text,
  "created_by" uuid DEFAULT auth.uid(),
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public."user_data_scope" (
  "user_id" uuid NOT NULL,
  "scope_key" text NOT NULL,
  "allowed" boolean DEFAULT false NOT NULL
);

CREATE TABLE IF NOT EXISTS public."workflow_instances" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "client_id" uuid,
  "stage" integer DEFAULT 1 NOT NULL,
  "data" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "started_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public."workflow_steps" (
  "id" bigint DEFAULT nextval('workflow_steps_id_seq'::regclass) NOT NULL,
  "instance_id" uuid,
  "stage" integer,
  "name" text,
  "role" text,
  "status" text,
  "updated_at" timestamp with time zone DEFAULT now()
);

ALTER SEQUENCE public."permissions_id_seq" OWNED BY public."permissions"."id";

ALTER SEQUENCE public."workflow_steps_id_seq" OWNED BY public."workflow_steps"."id";

ALTER TABLE public."activity_logs" ADD CONSTRAINT "activity_logs_pkey" PRIMARY KEY (id);

ALTER TABLE public."approvals" ADD CONSTRAINT "approvals_pkey" PRIMARY KEY (id);

ALTER TABLE public."assets" ADD CONSTRAINT "assets_pkey" PRIMARY KEY (id);

ALTER TABLE public."client_assignments" ADD CONSTRAINT "client_assignments_pkey" PRIMARY KEY (client_id, user_id);

ALTER TABLE public."clients" ADD CONSTRAINT "clients_pkey" PRIMARY KEY (id);

ALTER TABLE public."comments" ADD CONSTRAINT "comments_pkey" PRIMARY KEY (id);

ALTER TABLE public."employees" ADD CONSTRAINT "employees_pkey" PRIMARY KEY (id);

ALTER TABLE public."invoices" ADD CONSTRAINT "invoices_pkey" PRIMARY KEY (id);

ALTER TABLE public."migration_audit" ADD CONSTRAINT "migration_audit_pkey" PRIMARY KEY (id);

ALTER TABLE public."notifications" ADD CONSTRAINT "notifications_pkey" PRIMARY KEY (id);

ALTER TABLE public."permissions" ADD CONSTRAINT "permissions_pkey" PRIMARY KEY (id);

ALTER TABLE public."permissions" ADD CONSTRAINT "permissions_role_module_action_key" UNIQUE (role, module, action);

ALTER TABLE public."profiles" ADD CONSTRAINT "profiles_pkey" PRIMARY KEY (id);

ALTER TABLE public."profiles" ADD CONSTRAINT "profiles_username_key" UNIQUE (username);

ALTER TABLE public."proposals" ADD CONSTRAINT "proposals_pkey" PRIMARY KEY (id);

ALTER TABLE public."records" ADD CONSTRAINT "records_pkey" PRIMARY KEY (id);

ALTER TABLE public."requests" ADD CONSTRAINT "requests_pkey" PRIMARY KEY (id);

ALTER TABLE public."roles" ADD CONSTRAINT "roles_pkey" PRIMARY KEY (role);

ALTER TABLE public."settings" ADD CONSTRAINT "settings_pkey" PRIMARY KEY (id);

ALTER TABLE public."tasks" ADD CONSTRAINT "tasks_pkey" PRIMARY KEY (id);

ALTER TABLE public."user_data_scope" ADD CONSTRAINT "user_data_scope_pkey" PRIMARY KEY (user_id, scope_key);

ALTER TABLE public."workflow_instances" ADD CONSTRAINT "workflow_instances_pkey" PRIMARY KEY (id);

ALTER TABLE public."workflow_steps" ADD CONSTRAINT "workflow_steps_pkey" PRIMARY KEY (id);

CREATE UNIQUE INDEX IF NOT EXISTS records_accounts_email_unique ON public.records USING btree (lower(btrim((data ->> 'email'::text)))) WHERE ((coll = '_accounts'::text) AND (COALESCE(btrim((data ->> 'email'::text)), ''::text) <> ''::text));

CREATE UNIQUE INDEX IF NOT EXISTS records_accounts_username_unique ON public.records USING btree (lower(btrim((data ->> 'username'::text)))) WHERE ((coll = '_accounts'::text) AND (COALESCE(btrim((data ->> 'username'::text)), ''::text) <> ''::text));

CREATE INDEX IF NOT EXISTS records_coll_assigned_idx ON public.records USING btree (coll, ((data ->> 'assignedTo'::text)));

CREATE INDEX IF NOT EXISTS records_coll_client_idx ON public.records USING btree (coll, ((data ->> 'clientId'::text)));

CREATE INDEX IF NOT EXISTS records_coll_created_idx ON public.records USING btree (coll, ((data ->> 'createdAt'::text)));

CREATE INDEX IF NOT EXISTS records_coll_idx ON public.records USING btree (coll);

CREATE INDEX IF NOT EXISTS records_coll_updated_idx ON public.records USING btree (coll, updated_at DESC);

CREATE INDEX IF NOT EXISTS records_created_at_idx ON public.records USING btree (created_at DESC);

CREATE INDEX IF NOT EXISTS records_data_gin_idx ON public.records USING gin (data);

CREATE INDEX IF NOT EXISTS records_deleted_at_idx ON public.records USING btree (deleted_at) WHERE (deleted_at IS NOT NULL);

CREATE INDEX IF NOT EXISTS records_updated_at_idx ON public.records USING btree (updated_at DESC);

ALTER TABLE public.profiles ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- Existing metadata trigger is a prerequisite for projection timestamps.
create or replace function public.try_ts(t text)
returns timestamptz language plpgsql immutable as $$
begin
  return t::timestamptz;
exception when others then
  return null;
end;
$$;

create or replace function public.fill_sync_meta()
returns trigger language plpgsql as $$
begin
  if new.created_at is null then
    new.created_at := coalesce(public.try_ts(new.data->>'createdAt'), now());
  end if;
  new.created_by := coalesce(new.data->>'createdBy', new.created_by);
  new.updated_by := coalesce(new.data->>'updatedBy', new.data->>'lastEditedBy', new.updated_by);
  if lower(coalesce(new.data->>'_del','')) in ('true','1','t') then
    new.deleted_at := coalesce(new.deleted_at, now());
  else
    new.deleted_at := null;
  end if;
  return new;
end;
$$;
drop trigger if exists records_sync_meta on public.records;
create trigger records_sync_meta
  before insert or update on public.records
  for each row execute function public.fill_sync_meta();

COMMIT;
