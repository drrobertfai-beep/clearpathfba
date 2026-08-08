# Encryption-at-Rest Review

**Review date:** 2026-08-08  
**Scope:** Current ClearPathFBA repository at review time; this is a technical assessment, not a certification or legal opinion.

## Executive conclusion
The application has sound protection for selected secrets and credentials, but the primary data store is not encrypted. `data/clearpathfba.sqlite` (or the configured `DATABASE_PATH`) is a regular SQLite file containing client PHI, assessments, target behaviors, ABC/data points, hypotheses, progress/report payloads, sign-offs, and the audit log. Anyone who obtains the file with read access can inspect that content directly. The current posture is **acceptable for development/pilot environments with controlled host access; encryption and key-management remediation is required before production**.

## What the code currently protects

### Database and clinical data
`server/src/db.js` opens SQLite with `better-sqlite3` and a filesystem path (`process.env.DATABASE_PATH || path.resolve('data/clearpathfba.sqlite')`). No SQLite encryption key, SQLCipher configuration, or application-level encryption wrapper is present. Tables include `clients`, `assessments`, `target_behaviors`, `data_points`, `function_hypotheses`, `progress_reports`, `sign_offs`, and `audit_log`. Consequently, PHI and audit records are plaintext at rest in the database file, journal/WAL files where enabled, and any unencrypted copies or backups.

### Password hashes
`server/src/auth.js` uses Node `crypto.scryptSync` with N=16384, r=8, p=1, a random 16-byte salt, and a 64-byte derived key. Verification uses `crypto.timingSafeEqual`. Passwords are not stored in plaintext. A database-file attacker can still obtain password hashes and attempt offline guessing; password strength, rate limiting, and MFA reduce but do not eliminate this risk.

### Sessions
`server/src/auth.js` generates 32 random bytes (represented as a hex token), stores only a SHA-256 hash in `sessions`, and sets a seven-day expiry. A database-only thief cannot directly replay the token from the hash, but host/process access may expose live tokens, and hashes remain sensitive for offline attack/replay scenarios involving weak or leaked tokens.

### MFA
`server/src/mfa.js` stores each user's TOTP secret as a base32 value in `users.mfa_secret`; this is a verifier secret, not a one-way hash, so a database reader can potentially generate valid TOTP codes. Ten backup codes are generated and only SHA-256 hashes are stored in `mfa_backup_codes`; used codes are marked with `used_at`. The MFA token signing secret defaults to an explicitly insecure development fallback (`clearpathfba-mfa-change-in-production`) unless `MFA_TOKEN_SECRET` is supplied.

### Signing key
`server/src/signature.js` uses an Ed25519 organization private key at `data/keys/signing.pem` by default (overridable with `SIGNING_KEY_FILE`), creates the directory with normal filesystem APIs, and documents/enforces mode 0600 when writing. The private key is never returned by API-facing key/signature output; the public key and fingerprint are stored in `signing_keys`. A host or backup attacker who can read the private PEM can forge organizational signatures, despite the 0600 permission.

## Risk assessment
A copied SQLite file exposes identifiable client names, dates of birth where populated, gender, notes, consent/DBHDS flags, assessment narratives, behavioral observations, clinical measurements, report payloads, sign-off records, and audit metadata. It also exposes password hashes, TOTP secrets, session hashes, backup-code hashes, account roles/emails, and public signing metadata. An attacker with host-level access may additionally read the Ed25519 private key (subject to OS permissions), environment variables such as signing/MFA/database secrets, application memory, live bearer tokens, and unencrypted temporary/backups. Database encryption alone would not protect a running compromised host; layered host, secret, and access controls are required.

## Required production recommendations
1. **Encrypt the host volume and all database storage.** Use managed encrypted disks/volumes with provider-managed or customer-managed keys, restrict host/database filesystem access, and verify that SQLite journal/WAL/temp files are covered. Do not place PHI on developer laptops or unencrypted attached volumes.
2. **Migrate to PostgreSQL as planned and select database-level encryption controls.** The business plan already calls for PostgreSQL migration. Use provider/database encryption at rest, encrypted connections, restricted roles, and separate production credentials. If SQLite must remain temporarily, evaluate a maintained SQLCipher/encryption extension and its operational key handling; do not treat filesystem permissions as encryption.
3. **Encrypt backups and exports independently.** Configure encrypted, access-controlled, tested backups with documented retention and restore procedures. Encrypt generated exports and transfer channels; use de-identified exports by default.
4. **Put secrets and signing keys in a KMS/secrets manager.** Inject `MFA_TOKEN_SECRET`, OIDC secrets, database credentials, and the Ed25519 private key at runtime; keep them out of images, source, logs, and ordinary backups. Use KMS-backed key encryption, rotation, access audit, recovery escrow, and a documented signing-key rotation/revocation plan. Never ship with the MFA development fallback.
5. **Enforce TLS 1.2+ in production.** Terminate with managed certificates, protect service-to-service and backup connections, reject plaintext HTTP, and validate deployment configuration. At-rest safeguards do not replace transport encryption.
6. **Add pre-go-live verification.** Test permissions (including 0600 key handling), inspect snapshots/WAL/temp files and provider backups, exercise key rotation and restore, confirm logs do not contain secrets, and record evidence in the security review.

## Prioritized remediation
**P0 — before production:** encrypted database/volume and backups; production secrets manager/KMS; replace the MFA fallback; protect/rotate the signing key; enforce TLS.  
**P1 — during PostgreSQL migration:** provider/database encryption, least-privilege DB roles, encrypted connections, backup restore testing, and centralized audit export/integrity monitoring.  
**P2 — ongoing:** periodic key/access review, incident exercises, secret rotation, and validation that new PHI-bearing tables, exports, caches, and temporary files inherit encryption controls.

## Verdict
Current controls are useful defense in depth, but **the current at-rest posture is not suitable for production PHI** because the SQLite database and audit log are unencrypted and sensitive TOTP/signing material requires stronger secret protection. Proceed only as a controlled development/pilot deployment until the P0 items are evidenced and approved.
