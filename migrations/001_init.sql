-- One row per customer enquiry. The row is the source of truth for where the enquiry is in the pipeline.
CREATE TABLE enquiries (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),  -- also the enquiry_key stamped on the Proposales draft
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  -- Identity and original input (never modified, so extraction can be re-run)
  message_id       text        NOT NULL UNIQUE,                         -- dedupe key: a second delivery of the same email inserts nothing
  source           text        NOT NULL CHECK (source IN ('email', 'paste')),
  email_id         text,                                                -- provider id used to fetch the body later (email only)
  raw_subject      text,
  raw_body         text,                                                -- null until fetched for email rows
  sender           text,
  CONSTRAINT paste_has_body CHECK (source <> 'paste' OR raw_body IS NOT NULL),

  -- Where the enquiry is in the state machine
  status           text        NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued', 'processing', 'retrying', 'draft_created', 'needs_review', 'failed_permanent', 'ignored')),
  attempts         integer     NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz,                                         -- retry backoff: not claimable before this time

  -- Concurrency guards
  locked_until     timestamptz,                                         -- lease: a worker owns the row until this time; expires if the worker crashes
  version          integer     NOT NULL DEFAULT 0,                      -- bumped on every human edit; a stale edit matches zero rows
  override         boolean     NOT NULL DEFAULT false,                  -- "create draft anyway": skip the outcome decision

  -- Results
  extracted        jsonb,                                               -- model output per field: value, confidence, evidence quote
  flags            jsonb,                                               -- validation warnings
  model            text,
  prompt_version   text,
  proposal_uuid    uuid,
  proposal_url     text,
  last_error       text
);

-- The sweeper scans for claimable rows by status and due time.
CREATE INDEX enquiries_status_next_attempt_idx ON enquiries (status, next_attempt_at);

-- Audit trail: one row per pipeline step, shown as the timeline in the dashboard.
CREATE TABLE events (
  id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  enquiry_id  uuid        NOT NULL REFERENCES enquiries (id),
  step        text        NOT NULL,
  outcome     text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX events_enquiry_idx ON events (enquiry_id, created_at);
