# Contributing to agent-chat

## Before You Code

1. **Read the relevant code and docs first.** Before fixing anything, understand the full context — `SKILL.md`, `references/`, and the actual source. Don't assume.
2. **Find the root cause, not the symptom.** If messages are duplicating, the fix isn't a dedup flag — it's understanding why they duplicate in the first place. Dig deeper.
3. **Check CHANGELOG.md** for recent changes that might affect your work.

## Development Workflow

### Making Changes

1. **Fork the repo** and create a feature branch
2. **Write the code** — keep changes focused and minimal
3. **Add tests** — every new feature or fix needs test coverage
4. **Run all tests** before committing: `npm test` (must be 0 failures)
5. **Check diff for secrets** — no tokens, API keys, passwords, or personal data in commits
6. **Update CHANGELOG.md** — describe what changed under the next version heading
7. **Bump version** in `package.json` (semver: patch for fixes, minor for features, major for breaking)
8. **Update documentation** — if behavior changed, update `references/`, `SKILL.md`, or `README.md` as needed
9. **Open a PR** — describe the problem, root cause, and solution. PRs only, no direct push.

### Commit Messages

Use conventional format:
```
feat: short description of feature
fix: short description of fix
docs: documentation changes
test: adding or updating tests
```

### Testing

- Tests live in `test/unit/` — one file per feature area
- Test IDs use prefixes: `DELIVER-001`, `DISCOVERY-001`, `SETUP-001`, etc.
- New test files must be added to the `test` script in `package.json`
- Tests must work on macOS and Linux (skip platform-specific tests with a check)

### Code Style

- ES modules (`import`/`export`), not CommonJS
- Node.js built-ins only — minimize npm dependencies
- Security: pass sensitive data via env vars, never shell interpolation
- `verbose()` for debug logging, `console.error()` for errors, `console.warn()` for warnings
- Best-effort fallbacks: don't crash on missing config — degrade gracefully

## Architecture Principles

- **Two delivery channels**: human (Telegram) and AI (OpenClaw) are separate and complementary — never mix them
- **Security split**: AI must not see blind/flagged messages. If split can't work, degrade to unified mode with explicit warning
- **Discovery over hardcoding**: find binaries and configs dynamically, don't assume fixed paths
- **Graceful degradation**: every feature should work partially rather than fail completely
- **No silent failures**: if something breaks, log it and warn the user

## What NOT to Do

- ❌ Don't push directly to `main` — PRs only
- ❌ Don't commit secrets, tokens, or personal data
- ❌ Don't suppress errors silently without logging
- ❌ Don't fix symptoms — find and fix root causes
- ❌ Don't skip tests or CHANGELOG updates
- ❌ Don't make the free-standing `send.js` depend on the daemon running
