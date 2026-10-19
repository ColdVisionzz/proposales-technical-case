-- Guarantee 1, layer 3: the same text sent again (a new Message-ID each time) must not make a second draft.
-- `fingerprint` is a hash of the sender address and the normalised body, saved by the worker once the body is known.
-- `duplicate_of` points at the row whose draft this row adopted instead of creating its own.
-- `dedupe_cleared` is true once this row won the right to create: a retry of a cleared row skips the check.
ALTER TABLE enquiries
  ADD COLUMN fingerprint     text,
  ADD COLUMN duplicate_of    uuid REFERENCES enquiries (id),
  ADD COLUMN dedupe_cleared  boolean NOT NULL DEFAULT false;

CREATE INDEX enquiries_fingerprint_idx ON enquiries (fingerprint) WHERE fingerprint IS NOT NULL;
