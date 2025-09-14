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

Edit `proxy.config.json` in this folder:

```json
{
  "http": { "enabled": true, "host": "0.0.0.0", "port": 8080 },
  "routes": {
    "example.com": "http://127.0.0.1:3000",
    "api.example.com": "http://127.0.0.1:4000"
  },
  "requireExplicitHost": false,
  "allowIps": []
}
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
