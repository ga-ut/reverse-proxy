# Bun Reverse Proxy

Standalone Bun-based reverse proxy. Domain-based routing with JSON config,
path/query preservation, X-Forwarded-\* headers, and optional IP allowlist.

## Run

```sh
# run with config in the current directory
bun src/index.ts --config ./proxy.config.json

# or with HMR during development
bun --hot src/index.ts --config ./proxy.config.json

# running as root automatically installs/updates a systemd service
sudo bunx @ga-ut/reverse-proxy --config ./proxy.config.json
```

## Configure

Create `proxy.config.json` at the repo root. You can copy the example or generate it with one command.

- Copy the example:

  - `cp proxy.config.example.json proxy.config.json`

- Or create it in one shot (copy/paste):

  ```sh
  cat > proxy.config.json <<'JSON'
  {
    "http": { "enabled": true, "host": "0.0.0.0", "port": 443 },
    "routes": {
      "example.com": "http://127.0.0.1:3000",
      "api.example.com": "http://127.0.0.1:4000"
    },
    "requireExplicitHost": false,
    "allowIps": []
  }
  JSON
  ```

- `routes`: hostname (lowercase, no port) → target base URL
- `requireExplicitHost`: if true, unknown host returns 404 and logs an error
- `allowIps`: empty allows all; otherwise only listed IPs allowed

TLS is intentionally out-of-scope here; terminate TLS upstream (DNS/LB) and
forward plain HTTP to this proxy to keep responsibilities separate.

## Package & Distribute

Ship an executable build so others can run the proxy without cloning the repo.

1. `bun install`
2. `bun run build` → emits `dist/reverse-proxy` for your current platform
3. Publish the package (`npm publish`) or attach the binary to a release archive
4. Consumers can execute it directly:
   - `bunx @ga-ut/reverse-proxy --config ./proxy.config.json`
   - `npx --yes @ga-ut/reverse-proxy --config ./proxy.config.json`

> **Cross-platform note:** the binary produced by `bun build --compile` targets the
> host OS/architecture. Publish separate builds per platform (e.g. macOS, Linux)
> or run the build step on each release target before packaging.

## Deploy

- Keep `proxy.config.json` alongside the runtime (or pass `--config /path/to/proxy.config.json`)
- Run with a process manager (e.g., systemd) and health checks on the bound port

## Systemd Service

- Easiest path (requires sudo + systemd):
  - `sudo bunx @ga-ut/reverse-proxy --config /etc/reverse-proxy.json`
  - Running as root writes `/etc/systemd/system/reverse-proxy.service` that runs
    `bun start -- --config /etc/reverse-proxy.json` inside the config directory,
    exports `PROXY_CONFIG`, reloads systemd, enables, and restarts the unit.
  - Override defaults with flags like `--service-name`, `--service-user`, `--service-path`,
    `--service-binary` (custom bun path), `--service-env KEY=VALUE`, or disable automation via `--no-service`.
- Advanced/custom install:
  - `bun scripts/install-service.ts --user deploy --working-dir /srv/reverse-proxy --start`
  - Add `--enable-cap-net-bind` when you need to listen on ports 80/443
  - Use `--dry-run` to preview the generated unit file without touching systemd
  - Or copy `reverse-proxy.service.example`, adjust it, and install manually.
