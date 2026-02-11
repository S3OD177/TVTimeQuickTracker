# Security Audit Report

Date: February 11, 2026  
Scope: `/Users/saud/TVTimeQuickTracke` (manifest, `src/*`, packaging, and git history patterns)

## Result Summary

- No hardcoded user password or private key material found in current source.
- No high-entropy credential strings found in current source.
- No obvious secret leak found in scanned commit history patterns.
- One exposed static API key constant exists (service key).
- One major auth-hardening patch was applied during this audit.

## Findings

### 1) Static search API key is embedded in extension code

- Severity: Medium
- File: `src/background.js`
- Detail: `SEARCH_API_KEY` is shipped inside client extension code, so anyone can extract it from the extension package.
- Risk: Key abuse/rate-limit exhaustion if this key is considered sensitive by provider.
- Recommendation:
1. Prefer authenticated endpoint usage without static key, or
2. Move search mediation behind a controlled backend if policy allows, or
3. Treat this as a public key and apply provider-side usage restrictions (domain/origin/rate limits).

### 2) Persistent auth previously stored reversible Basic credentials

- Severity: High (fixed)
- Files: `src/background.js`
- Detail: Previous logic stored `auth` (Basic header) in `chrome.storage.local`.
- Action taken in this audit:
1. If bearer token exists, persistent `auth` is now cleared.
2. New logins store `auth` only when bearer is missing.
3. Migrated session records are normalized to avoid persisting `auth` alongside bearer.

### 3) UI HTML templating sanitization gap in helper

- Severity: Low (fixed)
- Files: `src/popup.js`
- Detail: `stateHTML()` inserted `title/sub` without centralized escaping.
- Action taken in this audit:
1. Added escaping in `stateHTML()` for title and subtitle.
2. Escaped `show.year` rendering in search results.

### 4) Release metadata incomplete for Web Store policy

- Severity: Low
- File: `docs/PRIVACY_POLICY.md`
- Detail: Placeholder email remains: `REPLACE_WITH_SUPPORT_EMAIL`.
- Recommendation: Replace with real support contact before publish.

## Additional Checks Performed

- Secret pattern scans (`api key`, token, private key, JWT-like strings).
- Unsafe API usage scan (`eval`, `new Function`, `document.write`, non-HTTPS endpoints).
- Manifest permission review.
- Git history pattern scan across all commits for common leaked credential signatures.

## Notes

- Bearer token persistence in `chrome.storage.local` is expected for extension login persistence.  
  This is a standard tradeoff for UX; keep host permissions minimal and avoid verbose logging.
- Packaging script currently excludes legacy root files and includes only:
  `manifest.json`, `src/`, `icons/`.
