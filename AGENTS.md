# Repository Guidelines

## Project Structure & Module Organization
- `src/index.ts` is the Bun entry point that loads `proxy.config.json`, normalizes routes, and boots the proxy.
- `src/systemd.ts` and `scripts/install-service.ts` host systemd helpers; keep platform-specific logic there.
- `dist/` stores binaries produced by `bun run build`; never edit these by hand.
- `proxy.config.example.json` is the template for `proxy.config.json`; keep secrets out of git.
- `reverse-proxy.service` documents the expected systemd unit layout for packaging.

## Build, Test, and Development Commands
- `bun install` fetches type definitions (no Node.js package managers).
- `bun --hot src/index.ts --config ./proxy.config.json` enables HMR; use `bun src/index.ts --config ./proxy.config.json` for a plain run.
- `bun run build` emits `dist/reverse-proxy`; add `bun run build:debug` when you need an inspectable bundle.
- `bun run clean` removes `dist/` so the next build starts fresh.

## Coding Style & Naming Conventions
- Use TypeScript with ESNext modules, top-level `await`, and Bun-first APIs (`Bun.file`, `Bun.env`).
- Keep the two-space indentation, prefer `const`, and apply PascalCase for types, camelCase for runtime identifiers, and kebab-case for CLI flags.
- Isolate systemd helpers in `src/systemd.ts` so the main entry remains portable.

## Testing Guidelines
- Add tests with `bun test` using `bun:test`; co-locate them as `*.test.ts` beside the code they cover.
- Exercise host routing, header propagation, and failure scenarios before merging.

## Commit & Pull Request Guidelines
- Mirror the existing history: short, lowercase, imperative commit subjects (e.g., `add install service`).
- Reference related issues, list config or ops impacts, and confirm `bun run build` and (when present) `bun test` before opening a PR.
- PR descriptions should summarize routing/config changes and include any helpful sample commands or logs.

## Configuration & Security Tips
- Protect production `proxy.config.json`; use the `PROXY_CONFIG` environment variable to point at managed paths.
- When enabling TLS, keep certificate/private-key paths out of git, prefer absolute paths for material stored under `/etc/ssl/private`, and ensure the systemd service user has read access without world permissions.
- Document whether TLS terminates inside the proxy or upstream so operators know where certificates and renewals live.
- Validate new unit files with `bun scripts/install-service.ts --dry-run` before touching `/etc/systemd/system`.
