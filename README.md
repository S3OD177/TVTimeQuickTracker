# TV Time Quick Tracker

TV Time Quick Tracker is a Chrome extension for quickly managing TV Time shows and episodes.

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

