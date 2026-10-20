# Contributing to NoSignal

Thanks for helping. Keep changes small and focused.

1. Fork, create a branch, and make your change.
2. Install and build: `npm ci && npm run build`.
3. Run the tests: `npm test` and `npm run test:security`. New behaviour needs a test under `tests/`.
4. The UI is Persian/RTL first: no 1px borders, follow the existing styles in `apps/web/src/styles/`.
5. Do not add runtime dependencies without discussing it in an issue first; the app must work with no international internet at runtime (no CDNs, no external fonts or APIs).
6. Never commit secrets, `.env` files, databases, or user media.

Security problems: do not open a public issue; see `SECURITY.md`.

By contributing you agree that your work is released under the MIT licence.
