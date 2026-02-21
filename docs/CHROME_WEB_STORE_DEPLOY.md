# Chrome Web Store Deployment Guide

Last updated: February 11, 2026

## 1. Production-Ready Status in This Repo

- Manifest is MV3 and points to `src/popup.html` + `src/background.js`.
- Auth persistence uses `chrome.storage.local` so users remain logged in across browser restart/extension update.
- Dashboard data is optimized with cache + preload in service worker.
- Refresh action bypasses cache using `forceRefresh`.
- Runtime package script added: `scripts/package-extension.sh`.

## 2. Pre-Deploy Checklist

1. Confirm manifest version is correct in `manifest.json`.
2. Validate JavaScript syntax:
   - `node --check src/background.js`
   - `node --check src/popup.js`
3. Load extension unpacked in Chrome and test:
   - Login persistence after browser restart.
   - Watch List + Upcoming rendering.
   - Mark watched/unwatched.
   - Search + follow/unfollow.
   - Logout/login flow.
4. Confirm no debug/sensitive logs in production behavior.
5. Update privacy policy contact in `docs/PRIVACY_POLICY.md`.

## 3. Build the Upload ZIP

Run:

```bash
chmod +x scripts/package-extension.sh
./scripts/package-extension.sh
```

Output:

- `dist/tv-time-quick-tracker-v<version>.zip`

This ZIP includes only:

- `manifest.json`
- `src/`
- `icons/`

## 4. Chrome Web Store Submission Steps

1. Go to [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).
2. Create new item (first release) or open existing item (update).
3. Upload ZIP from `dist/`.
4. Fill listing:
   - Name: `TV Time Quick Tracker`
   - Summary and detailed description.
   - Category (recommended: `Productivity` or `Entertainment`).
5. Upload store assets:
   - 128x128 icon.
   - At least 1 screenshot (recommended 1280x800 or 640x400).
6. Add privacy policy URL:
   - Host `docs/PRIVACY_POLICY.md` content on a public URL.
7. Complete Data disclosure form:
   - Explain auth tokens and TV tracking data are processed to provide core function.
   - Confirm data is not sold.
8. Submit for review.

## 5. Updating Without Forcing Re-Login

Users should stay logged in when all of the following are true:

1. Same Chrome Web Store extension item (same extension ID).
2. Data is kept in `chrome.storage.local` (already implemented).
3. Token has not expired on server side.

If users are asked to log in again after update, verify:

1. You did not publish as a new extension item.
2. You did not clear storage in migration code.
3. API is not returning 401/403 (which correctly clears expired auth).

## 6. Permission Justification Text (for review form)

- `storage`: store local auth/session and cached UI data for fast popup load.
- Host permissions: limited to the minimum required service endpoints used for authentication, search, account data retrieval, episode state updates, and artwork loading.

## 7. Release Process for Each Version

1. Update version in `manifest.json`.
2. Run checks and manual QA.
3. Build ZIP via `scripts/package-extension.sh`.
4. Upload ZIP in Developer Dashboard.
5. Add release notes.
6. Submit/publish.

## 8. Recommended Store Listing Notes

- Mention this extension is an unofficial companion for tracking TV Time data quickly in-browser.
- Clarify user must have a valid TV Time account.
- Mention no separate publisher backend data storage.
