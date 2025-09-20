# Bun Reverse Proxy

Standalone Bun-based reverse proxy. Domain-based routing with JSON config,
path/query preservation, X-Forwarded-\* headers, and optional IP allowlist.

## Run

```sh
bun src/index.ts
# or with HMR during development
bun --hot src/index.ts
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

## Deploy

- Copy this `proxy/` folder to a new repository
- Keep `proxy.config.json` alongside `src/index.ts`
- Run with a process manager (e.g., systemd) and health checks on the bound port

## Systemd Service

- Auto-install with Bun:
  - `bun scripts/install-service.ts --user deploy --working-dir /srv/reverse-proxy --start`
  - Add `--enable-cap-net-bind` when you need to listen on ports 80/443
  - Use `--dry-run` to preview the generated unit file without touching systemd
- Manual path (same template as the script uses):
  - Copy `reverse-proxy.service.example` and adjust `User`, `Group`, `WorkingDirectory`, and PATH
  - `sudo cp reverse-proxy.service /etc/systemd/system/`
  - `sudo systemctl daemon-reload`
  - `sudo systemctl enable --now reverse-proxy`
  - Logs: `journalctl -u reverse-proxy -f`
