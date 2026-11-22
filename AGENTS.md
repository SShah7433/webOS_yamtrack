# Repository Guidelines

## Project Structure

- `app/` contains the packaged LG webOS launcher, its `appinfo.json` manifest, and icons. The launcher connects to the LAN helper.
- `helper/` contains the Flask application, upstream proxy, and CSS compatibility code. `helper/static/` contains the pairing UI, remote navigation, TV styles, fonts, and vendored Chart.js.
- `tests/` contains Python and JavaScript tests. `scripts/build.py` packages the app and helper bundle. `.github/workflows/build.yml` runs CI and publishes tagged releases.

## Build, Test, and Development

Run these commands from the repository root:

- `python3 -m venv .venv` and `.venv/bin/python -m pip install -r requirements.txt` set up the helper dependencies. CI uses Python 3.12.
- `.venv/bin/python -m unittest discover -s tests -v` runs the helper and packaging tests.
- `node --test tests/test_*.js` runs the launcher, client, pairing, and navigation tests with Node’s built-in runner.
- `python3 scripts/build.py` creates the unsigned IPK, checksum, and deployment bundle in `dist/`. Local builds use the manifest version. Release tags use `vX.Y.Z`.
- Set `YAMTRACK_URL` and `TV_PUBLIC_URL` to LAN origins in `.env`, then run `docker compose -p yamtrack-tv up -d --build` to start the helper on port 8765. Open `/__tv/pair` on the helper to check reachability.

## Coding Style

Use four spaces and `snake_case` for Python, and two spaces and `camelCase` for browser JavaScript. Keep browser-facing JavaScript and CSS compatible with Chromium 68 on webOS 5.x. Preserve third-party license notices when updating bundled assets.

When fixing a CSS issue, check other pages that use the same component or layout. If the issue can recur across pages, fix the shared CSS and verify the fix on representative pages. Use page-specific selectors for issues unique to that page.

## Testing

Name test files `test_*.py` or `test_*.js`. Use `test_*` methods in Python and descriptive test names in JavaScript. Reuse the simulated Yamtrack upstream for pairing and proxy regressions. For TV UI changes, verify focus and remote behavior on webOS hardware when available. CI runs both suites, checks the IPK checksum, and smoke-tests the helper image.

## Commits and Pull Requests

Commit along the way as each logical block of work is complete and verified. Keep each commit focused on one coherent change, with its related tests and documentation. Use short imperative subjects such as “Fix TV calendar action layout.” In pull requests, describe the behavior change and the checks you ran. Link related issues when available, and include screenshots for visible changes when helpful. Keep local `.env` and `data/sessions.json` out of commits.
