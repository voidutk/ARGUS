-- Records which encryption key version sealed each exhibit, so
-- EVIDENCE_ENCRYPTION_KEY can rotate without stranding everything already
-- encrypted under the previous key (see cryptoService.js keyring()).
-- Existing rows default to 1: this migration ships alongside the first
-- rotation-aware code, so every row encrypted before it is necessarily under
-- whatever key was active — version 1 by convention.

ALTER TABLE evidence
  ADD COLUMN IF NOT EXISTS key_version SMALLINT NOT NULL DEFAULT 1;
