# Repository security refresh — 2026-10-10

## Scope and status
This branch is a quarantine-style maintenance branch. It does **not** certify this code as safe.

### Reviewed (read-only)
- `README.md`: advertises guided installers and provider authentication; do not execute until audited.
- `package.json`: Node >=22.19, proper-lockfile dependency, test/check scripts.
- `requirements/python.txt`: hashed Python dependency lock; regenerate only with reviewed tooling.
- `.github/workflows/ci.yml`: tests across Linux, macOS and Windows, plus desktop builds.

### Safety gates before any deployment or release
1. Inventory all executable entry points, hooks, workflow permissions, and download URLs.
2. Inspect install.sh, install.ps1, bin/, scripts/, desktop build and provider authentication paths for credential access, persistence and network egress.
3. Review dependency manifests and lockfiles; upgrade in small batches with changelogs and reproducible tests.
4. Verify the provenance of downloaded binaries and GitHub Actions; pin third-party Actions to immutable commit SHAs.
5. Scan for committed secrets and unsafe logging, and rotate any confirmed exposed secrets.
6. Run static checks and tests only inside disposable, isolated CI with least privilege and no provider secrets.
7. Publish a reviewable PR; do not merge, release, install or deploy without verification.

### Isolation
- Do not use this router in DevTask or the cloud workbench.
- Do not import host profiles, SSH keys, API credentials, tokens, or local proxy settings.
- Do not enable install scripts, background services, or model-provider logins during the audit.

### Next
This document is the initial security baseline, not a completed repository cleanup or upgrade.
