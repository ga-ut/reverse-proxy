# Bun Reverse Proxy

Standalone Bun-based reverse proxy. Domain-based routing with JSON config,
path/query preservation, X-Forwarded-\* headers, optional TLS termination,
and IP allowlists.

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
    "allowIps": [],
    "tls": {
      "enabled": false,
      "certPath": "./certs/example.crt",
      "keyPath": "./certs/example.key",
      "caPath": "./certs/ca-bundle.crt"
    }
  }
  JSON
  ```

- `routes`: hostname (lowercase, no port) → target base URL
- `http.redirect.enabled`: when `true` and TLS is configured, start a lightweight listener on `http.redirect.port` (default `80`) that issues a redirect with `http.redirect.statusCode` (default `307`) to the HTTPS port.
- `requireExplicitHost`: if true, unknown host returns 404 and logs an error
- `allowIps`: empty allows all; otherwise only listed IPs allowed
- `tls.certPath` & `tls.keyPath`: PEM-encoded certificate and private key. Relative paths resolve against the config file directory; use absolute paths for keys stored in `/etc/ssl/private`.
- `tls.requestClientCert`: set to `true` to require mutual TLS (client certificates). Default `false`.
- `tls.caPath`: optional list/string of CA files used to validate client certificates **only** when `tls.requestClientCert` is `true`. Leave unset for standard HTTPS.
- `tls.passphrase`: optional passphrase used to decrypt the private key when it is encrypted.
- Omit or set `tls.enabled` to `false` to skip TLS; the proxy stays HTTP-only.

Set `tls.enabled` to `true` only after pointing at real certificate and key files.

> **Key security:** when running under `systemctl`, ensure the service user can read the key file without exposing it broadly (e.g., group-readable in `/etc/ssl/private`).

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
- Ensure the configured service user can read the TLS key file (e.g., place it in `/etc/ssl/private` and adjust group ownership instead of loosening permissions)

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
