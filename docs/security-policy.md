# ClearPathFBA Security Policy

**Status:** Pre-production policy; to be operationalized and approved before go-live. **Scope:** ClearPathFBA application, infrastructure, workforce, and vendors handling client FBA information. ClearPathFBA is HIPAA-aligned; this document is not a representation of HIPAA certification or compliance.

## 1. Governance and risk-based operation
The organization maintains confidentiality, integrity, and availability safeguards appropriate to behavioral-health information and Virginia DBHDS-oriented workflows. Security controls are reviewed at least annually and after material changes, incidents, or vendor changes. Exceptions require documented risk acceptance, owner approval, compensating controls, and an expiry date.

## 2. Access control and authentication
- Access is least-privilege and role based. Supported roles are **admin, bcba, specialist, supervisor, staff, and guardian**; permissions are enforced server-side, not only in the UI. Administrative functions are restricted to admins.
- Passwords must be unique, not shared, and meet the production password standard (minimum 12 characters, screened against common/compromised passwords, and changed on suspected compromise). Seed credentials must be changed before production.
- Passwords are never stored in plaintext. `server/src/auth.js` uses Node scrypt (N=16384, r=8, p=1), a random 16-byte salt, a 64-byte derived key, and timing-safe comparison. Production parameters are reviewed as computing risk changes.
- TOTP MFA is available and required for production privileged accounts (and for all users where organizational risk requires it). Enrollment verifies an authenticator code and issues ten single-use backup codes; backup codes are displayed once and stored only as SHA-256 hashes. Five failed MFA attempts cause a temporary lockout. Login failures are rate limited and five failed password attempts cause a temporary account lockout.
- Sessions use 32 random bytes; only a SHA-256 token hash is stored. Sessions expire after seven days and must be revoked on disablement, suspected compromise, or logout capability implementation. Tokens must be transmitted only over TLS.
- OIDC SSO is supported when configured. Accounts are linked by verified, normalized email to an existing active account; there is no automatic provisioning. The implementation validates issuer, audience, nonce, expiry, signature, and authorization state. Raw access/ID tokens are not written to audit records.

## 3. Encryption and integrity
- Production traffic must use TLS 1.2 or newer, redirect or reject plaintext HTTP, use managed certificates, and disable weak protocols/ciphers. Internal service and backup traffic receives equivalent protection.
- At-rest encryption is mandatory before production. The current SQLite posture and required controls are documented in [the encryption-at-rest review](encryption-at-rest-review.md).
- The organization Ed25519 signing private key is kept server-side at `data/keys/signing.pem`, with mode 0600, and is never exposed through API responses. Production key storage must use protected secret/key-management facilities and a rotation/recovery procedure. Public keys and fingerprints may be retained for verification.

## 4. Application and data safeguards
Security middleware sets `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and a restrictive Content-Security-Policy; changes require review. Authentication endpoints are rate limited. PHI is minimized to what is needed for care, assessment, reporting, and administration. Users must not place unnecessary identifiers in notes or exports. De-identified CSV/JSON and document exports must be used for testing, analytics, and sharing whenever possible. Access, changes, exports/imports, document generation, and signatures are audit logged.

## 5. Incident response
This process is a policy requirement to be operationalized before go-live. The organization designates an incident owner and escalation contacts. Suspected events may be reported by users, monitoring, vendors, or administrators and are recorded with time, scope, systems, and evidence. The incident owner triages severity, preserves logs, and coordinates technical investigation. Containment may include disabling accounts, revoking sessions/keys, isolating hosts, restricting endpoints, and preserving forensic copies. Recovery includes eradication, restoration from known-good backups, validation, and heightened monitoring. Legal/privacy leadership determines whether an event is a reportable breach and provides required notifications to affected individuals, regulators, customers, and partners within applicable contractual and legal timeframes. A post-incident review records root cause, corrective actions, owners, and due dates without including unnecessary PHI.

## 6. Backup, retention, and disposal
Production backups must be encrypted, access controlled, integrity checked, monitored, and tested through restoration exercises at least quarterly. Recovery objectives, retention periods, and legal holds are documented per customer agreement and applicable law; absent a stricter requirement, operational backups use a documented rolling schedule and are securely disposed of when expired. Data and media disposal uses verifiable secure deletion or destruction. Audit records are retained according to [the Audit Policy](audit-policy.md) and legal/customer requirements.

## 7. Responsibilities
The **organization** owns risk decisions, workforce training, role assignment/review, incident and breach decisions, retention, customer commitments, and approval of production changes. Administrators provision and remove access promptly and review access regularly. Users protect credentials, use MFA, report incidents, and access only assigned information. The **hosting provider** is responsible for physical facilities, underlying host controls, availability, managed TLS/backup services where contracted, and security notifications under contract; it does not replace ClearPathFBA's application, configuration, identity, or data-governance responsibilities. Vendors handling PHI require appropriate due diligence and agreements before production use.

## 8. Review and approval
The security owner reviews this policy annually and after material architecture or threat changes. Approval, version, effective date, and exceptions are maintained in the organization's policy register.
