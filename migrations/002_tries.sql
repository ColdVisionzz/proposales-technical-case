-- `attempts` is the claim ticket (fencing token): +1 on every claim, never reset, so a ticket number is never handed out twice.
-- `tries` counts claims since the last manual reset. The attempt cap reads it, and manual retry zeroes it.
-- Both go up in the claim statement, so a crash (which runs no code) is counted too.
ALTER TABLE enquiries ADD COLUMN tries integer NOT NULL DEFAULT 0;

-- Rows that already ran keep their history: their tries equal their claims so far.
UPDATE enquiries SET tries = attempts;
