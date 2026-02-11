# TV Time Quick Tracker

TV Time Quick Tracker is a Chrome extension for quickly managing TV Time shows and episodes.

## 🔒 Security & Production Status

**Status**: ✅ **Production Ready** - All security audits passed

- ✅ CodeQL Security Scan: 0 vulnerabilities
- ✅ Content Security Policy: Enabled
- ✅ HTTPS-Only Communication
- ✅ No Hardcoded Credentials
- ✅ XSS Protection: Full HTML escaping
- ✅ Secure Token Storage

📄 **Security Documentation**:
- [Production Readiness Report](docs/PRODUCTION_READINESS_REPORT.md)
- [Security Policy](docs/SECURITY.md)
- [Deployment Quick Start](docs/DEPLOYMENT_QUICKSTART.md)

## Status

This repository is shared for **contribution only**.

- You may read the code.
- You may propose improvements via pull requests.
- You may **not** duplicate, reuse, redistribute, or deploy this project without explicit written permission.

See the full terms in `LICENSE`.

## Project Structure

- `manifest.json` - Chrome extension manifest
- `src/background.js` - service worker and API logic
- `src/popup.html` - popup layout
- `src/popup.css` - popup styles
- `src/popup.js` - popup behavior
- `icons/` - extension icons
- `scripts/package-extension.sh` - build zip package
- `docs/` - deployment, privacy, and security docs
  - `PRODUCTION_READINESS_REPORT.md` - Security assessment
  - `SECURITY.md` - Security policy and vulnerability reporting
  - `DEPLOYMENT_QUICKSTART.md` - Production deployment guide
  - `PRIVACY_POLICY.md` - Privacy policy
  - `CHROME_WEB_STORE_DEPLOY.md` - Chrome Web Store guidelines

## Documentation

## Local Development

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this folder

## Build Package

```bash
chmod +x scripts/package-extension.sh
./scripts/package-extension.sh
```

Output zip:

- `dist/tv-time-quick-tracker-v<version>.zip`

## Contributing

1. Fork the repository
2. Create a branch
3. Commit your changes
4. Open a pull request

By submitting a contribution, you agree that project owner may use, modify, and relicense your contribution.

## Security

To report security vulnerabilities, please email **salbinzaid@gmail.com** with details.

See [SECURITY.md](docs/SECURITY.md) for full security policy.


