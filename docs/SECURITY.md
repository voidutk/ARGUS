# ARGUS — Security Architecture & Threat Model

This document exists to answer one question precisely: **why should anyone
trust that an ARGUS exhibit hasn't been tampered with, and who could break
that trust if they tried?** It covers the evidence encryption pipeline, the
blockchain chain-of-custody layer, and the auth/access-control surface around
them — what's mitigated, what's a documented limitation, and why each design
choice was made.

## 1. Evidence at rest — encryption

- **AES-256-GCM**, a fresh random IV per file. Reusing an IV under the same
  key breaks GCM's confidentiality guarantee outright, so this is non-negotiable.
- **AAD (associated authenticated data)** binds every ciphertext to its own
  evidence row (`evidence:<id>`). Without this, a valid `(ciphertext, iv,
  authTag)` triple copied wholesale from one evidence row onto another still
  decrypts and authenticates cleanly — GCM only proves "this ciphertext came
  from this key and this IV," not "this ciphertext belongs to this row." AAD
  closes that: decrypting evidence row A's data using row B's id as AAD fails
  outright, even though the ciphertext and auth tag are each individually
  valid. This defends against an attacker with combined DB-write + disk-write
  access trying to swap one exhibit's entire crypto envelope onto another
  exhibit's identity.
- **The SHA-256 digest anchored on-chain is over the plaintext, not the
  ciphertext.** Ciphertext changes every time it's re-encrypted (rotation,
  re-keying) — a ciphertext hash would never survive that and would prove
  nothing about the actual exhibit content. The plaintext digest is the
  content's fingerprint; the on-chain record is a claim about that content,
  not about any particular encrypted representation of it.

## 2. Key management

- `EVIDENCE_ENCRYPTION_KEY` and `JWT_SECRET` are validated for strength and
  format at **boot**, not just presence — a 64-hex-char requirement, rejection
  of the shipped example placeholders, rejection of an all-zero key. A weak
  secret now fails loudly at startup instead of silently working until the
  worst possible moment (a forged JWT, or evidence nobody can ever decrypt
  again).
- **Key rotation is versioned, not destructive.** Every evidence row stores
  `key_version` — the id of the key that sealed it. `EVIDENCE_ENCRYPTION_KEY`
  + `EVIDENCE_ENCRYPTION_KEY_VERSION` is the *active* key, used for all new
  encryption. `EVIDENCE_ENCRYPTION_KEY_PREVIOUS` holds retired keys
  (`version:hexkey`, comma-separated) — decrypt-only, so rotating the active
  key never strands exhibits sealed under an older one. `scripts/rotate-evidence-key.js`
  re-encrypts old exhibits onto the active key on demand (verifying the
  plaintext digest before writing anything back), so a retired key can
  eventually be deleted from `EVIDENCE_ENCRYPTION_KEY_PREVIOUS` entirely.
- **Known limitation:** this is a single flat symmetric key per version, held
  in an env var — not a KMS/HSM-backed envelope scheme. For a hackathon build
  this is a deliberate scope decision, not an oversight; a production
  deployment handling real case evidence should move key custody to a managed
  KMS.

## 3. Access control on evidence

- `POST /evidence/upload`, `POST /evidence/:id/verify`, and
  `GET /evidence/:id/download` require ADMIN, SUPERVISOR, or INVESTIGATOR —
  ANALYST can see metadata and the custody trail (`GET /evidence`,
  `GET /evidence/:id/history`) but cannot pull raw decrypted bytes.
- Uploads are filtered by MIME type (images, PDFs, common office/audio
  formats). This is a plausibility check, not a hard security boundary —
  client-supplied MIME type is trivially spoofable — but it stops obviously
  wrong uploads (executables, archives) from ever being encrypted and
  anchored as if they were legitimate evidence.
- Every upload/verify/download/sweep is written to the append-only
  `audit_logs` table (actor, action, entity, metadata, IP) — this table is
  also what powers the Investigation Timeline page, so an unlogged action is,
  by ARGUS's own definition, an action that didn't happen as far as
  accountability is concerned.

## 4. Chain of custody — the trust boundary between the app and the chain

`EvidenceRegistry.sol` stores **only** a SHA-256 digest and case metadata —
never the exhibit, never ciphertext, never a key, never a storage path, never
victim PII. Registering a digest proves an exhibit existed in a given state
at a given time and hasn't changed since; nothing more.

The part that actually carries evidentiary weight is
`getEvidenceHistory()` — every verification, pass or fail, is appended
permanently. A tampered exhibit that stopped matching leaves a mark nobody
can remove, on the same terms as a clean pass. `backend/scripts/evidence-e2e.js`
proves this end-to-end against a live chain: upload → verify (pass) → tamper
→ verify (fails, permanently recorded) → a second, harder tamper (swap
*another* exhibit's entire crypto envelope onto this row) → still caught, via
the AAD mismatch this time rather than a hash mismatch.

**One honest limitation:** every on-chain transaction is submitted by a
single relayer wallet (`chainService.js`), so `msg.sender` on every
`registerEvidence`/`logVerification` call is always the relayer address, not
the individual investigator who actually ran the check. The chain alone
cannot distinguish which officer performed a given verification. ARGUS
compensates by folding the investigator's identity into the custody note
itself (`"<result> — verified by <email>"`) before it's written on-chain, so
per-officer accountability lives inside the immutable trail even though the
transaction sender doesn't vary. The alternative — giving every investigator
their own wallet and private key — was judged not worth the operational
complexity for this build, but is the natural next step for a deployment
that needs on-chain non-repudiation per officer rather than per note.

**Signer safety:** the app refuses to fall back to an unlocked local signer
against any network other than the local Hardhat node. Attempting that
fallback against a real network (Amoy, mainnet) would either throw an opaque
RPC error or, worse, silently resolve to an address nobody controls — the
code now fails explicitly at startup instead (`CHAIN_PRIVATE_KEY is required
for network "<network>"`).

**Anchoring reliability:** anchoring is asynchronous (a testnet tx takes
~15s; blocking an upload on that would make every demo feel broken), so a
dead RPC during one upload previously left that exhibit `PENDING` forever
with no path back. A 5-minute automatic sweep (`chainService.retryFailedAnchors`)
now requeues `FAILED`/stuck `PENDING` anchors, capped at 5 attempts with a
2-minute cooldown so a genuinely broken chain doesn't spin forever. An admin
can also trigger a retry manually (`POST /chain/retry-failed`).

## 5. Auth

- JWT bearer tokens, 8h expiry, bcrypt password hashing.
- **Per-IP rate limiting** on `/auth/login` (existing) plus **per-account
  lockout** (new): failed-login attempts are counted per email address via
  `audit_logs`, independent of source IP. This catches an attacker spreading
  guesses across many IPs or a rotating proxy, which the IP limiter alone
  would never see. Checked before the bcrypt comparison, so a locked-out
  account also stops burning CPU cycles on hash comparisons. Thresholds are
  tuned dev-permissive / prod-strict, mirroring the existing rate-limiter
  pattern, specifically so repeated smoke-test/demo-rehearsal runs against
  the shared seeded accounts can't lock the team out of its own demo.
- Login returns the same generic error for an unknown email and a wrong
  password — distinguishing them would let an attacker enumerate valid
  accounts.
- `helmet()` is applied globally for standard security headers (HSTS,
  no-sniff, frame-deny, etc.) — safe defaults for a pure JSON API with no
  HTML surface to tune a CSP against.

## 6. Deliberately out of scope for this build

- **RBAC coverage on non-evidence routes** (complaints, entities) — only
  evidence, graph-rebuild, analytics, and admin routes are role-gated today.
  Extending this is a straightforward application of the same `rbac()`
  middleware already used elsewhere, left for whoever owns those controllers.
- **On-chain string length caps.** `EvidenceRegistry.sol` accepts unbounded
  `evidenceType`/`unitCode`/`note` strings with no on-chain limit — a
  theoretical gas-griefing surface. In practice, `evidenceType`/`unitCode`
  are already constrained to short values by Postgres `CHECK` constraints
  before they ever reach the contract, and `note` is truncated to 200 chars
  in `chainService.js`. Enforcing the cap on-chain too would require
  modifying and redeploying an already-tested, already-deployed contract —
  a decision left to whoever owns the blockchain module, not made
  unilaterally here.
- **KMS/HSM-backed key custody** — see §2.

## 7. Verifying all of this yourself

```
cd backend && npm install && npm run migrate
npm run seed              # if you need fresh demo data
npm run verify-all        # smoke + evidence-e2e (needs a running Hardhat node + local deploy)
cd ../blockchain && npx hardhat test    # 21 contract tests
```

`evidence-e2e.js` is the single most convincing artifact here — it runs the
full tamper-detection story against a live chain and fails loudly (exit code
1) if the claims in this document stop being true.
