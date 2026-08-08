# ClearPathFBA Audit Policy

**Status:** Pre-production policy; to be operationalized before go-live. ClearPathFBA is HIPAA-aligned and not represented as HIPAA-certified.

## 1. Purpose and principles
Audit records support accountability, incident detection, clinical-document integrity, and access review. Logging is designed to capture who, what, when, and relevant entity without recording passwords, TOTP codes, backup-code values, access tokens, or unnecessary PHI. The audit trail is append-only through the application interface; database administrators and hosting controls must also protect it from unauthorized alteration.

## 2. Events recorded
The application records, as applicable:
- successful and failed password logins, account lockouts/unlocks, and failed-login metadata;
- MFA enrollment, successful and failed MFA verification (including a one-way request fingerprint rather than the submitted code), backup-code use, and MFA administration;
- SSO/OIDC start, success, and failure, with provider identifiers and a truncated SHA-256 email hash; raw authorization, ID, and access tokens are not logged;
- session/authentication and account-management events;
- user creation, role/status/password/email changes, administrative actions, and access changes;
- client, assessment, behavior, data-point, hypothesis, import, and deletion changes;
- CSV/JSON/document exports, including de-identified status and format where available;
- report/document generation and sign-off creation, signing, revocation, and cryptographic signature metadata.

Logs must not contain passwords, MFA secrets/codes, backup-code plaintext, private signing keys, bearer tokens, or full unnecessary clinical narratives. Reviewers redact accidental sensitive content and document the correction without destroying the original evidentiary record.

## 3. Storage, retention, and protection
The current `audit_log` table resides in the application SQLite database and is linked to assessments where relevant. It stores actor, action, structured JSON details, and timestamp. Production audit storage must be encrypted at rest, access controlled, backed up, monitored for deletion/tampering, and retained for the organization's documented legal, contractual, and operational period. The security owner sets the retention schedule with privacy/legal input; legal holds override normal disposal. Audit exports are treated as sensitive and are de-identified or minimized where possible.

## 4. Access and review
The global audit feed (`GET /api/admin/audit-log`) is restricted to the `admin` role; assessment-specific records are available only through authenticated, authorized application access. Administrators may investigate logs as part of their duties; security/privacy, designated investigators, and authorized auditors receive least-privilege access. Database or hosting access is limited to approved operators and is itself subject to provider/platform logging. No user may alter audit records as part of ordinary application use.

Automated controls should review authentication anomalies, repeated failures, lockouts, privilege changes, unusual exports, and signing failures weekly (or continuously where monitoring is available). A designated administrator or security reviewer performs and records a human review at least monthly, including access changes, privileged activity, failed controls, and unresolved alerts. Findings receive an owner and due date; critical findings are escalated immediately under the Incident Response process.

## 5. Integrity, investigation, and limitations
Audit timestamps use the application/database clock and must be synchronized in production. Backups and, where feasible, an append-only external sink or integrity seal should protect against host/database compromise. Investigators preserve the relevant database, application logs, provider logs, and time context, maintain chain-of-custody notes, and avoid modifying source evidence. The audit feed is an operational control, not proof that an event outside instrumented application paths did not occur; coverage is expanded when new workflows are deployed.

## 6. Responsibilities and review
Administrators configure access and monitor the feed. The security owner defines alerts, coordinates investigations, and reviews this policy annually. The organization determines retention, legal holds, and breach notification. Hosting providers protect infrastructure and provide contracted platform logs and incident notifications. This policy is reviewed before production, annually thereafter, and after material incidents or architecture changes.
