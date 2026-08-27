-- Anchoring is asynchronous and previously fire-and-forget: a FAILED or
-- stuck PENDING row had no path back to ANCHORED short of a human noticing
-- and re-triggering it by hand. These columns let chainService.retryFailedAnchors
-- requeue automatically, with a cooldown (last_attempt_at) and a cap
-- (retry_count) so a permanently broken RPC doesn't spin forever.

ALTER TABLE evidence_anchors
  ADD COLUMN IF NOT EXISTS retry_count SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ;
