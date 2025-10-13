import type { Server } from "bun";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pkgJson from "../package.json" assert { type: "json" };
import { installSystemdService } from "./systemd";

type HostMap = Record<string, string>;

interface RawHttpRedirectConfig {
  enabled?: boolean;
  port?: number;
  statusCode?: number;
}

interface HttpRedirectConfig {
  enabled: boolean;
  port: number;
  statusCode: number;
}

interface RawTlsConfig {
  enabled?: boolean;
  certPath?: string;
  keyPath?: string;
  caPath?: string | string[];
  passphrase?: string;
  requestClientCert?: boolean;
}

interface TlsConfig {
  enabled: true;
  certPath: string;
  keyPath: string;
  caPaths: string[];
  passphrase?: string;
  requestClientCert: boolean;
}

interface RawProxyConfig {
  http?: {
    enabled?: boolean;
    host?: string;
    port?: number;
    redirect?: RawHttpRedirectConfig | null;
  };
  routes?: HostMap;
  requireExplicitHost?: boolean;
  allowIps?: string[];
  tls?: RawTlsConfig | null;
}

interface ProxyConfig {
  http: {
    enabled: boolean;
    host: string;
    port: number;
    redirect: HttpRedirectConfig;
  };
  routes: HostMap;
  requireExplicitHost: boolean;
  allowIps: string[];
  tls: TlsConfig | null;
  configDir: string;
}

interface RunOptions {
  configPath?: string;
}

interface CliOptions extends RunOptions {
  help: boolean;
  version: boolean;
  unknown: string[];
  installService?: boolean;
  noService: boolean;
  serviceName?: string;
  serviceUser?: string;
  serviceGroup?: string;
  serviceWorkingDir?: string;
  bunBinary?: string;
  servicePath?: string;
  serviceDryRun: boolean;
  serviceForce?: boolean;
  serviceCapNetBind?: boolean;
  serviceExtraArgs: string[];
  serviceEnv: string[];
}

class UnknownHostError extends Error {
  constructor(public readonly host: string) {
    super(`No proxy target configured for host: ${host}`);
    this.name = "UnknownHostError";
  }
}

const VERSION = (pkgJson as { version?: string }).version ?? "0.0.0";

const HTTP_REDIRECT_DEFAULTS = {
  enabled: false,
  port: 80,
  statusCode: 307,
} as const;

const CONFIG_DEFAULTS = {
  http: { enabled: true, host: "0.0.0.0", port: 80, redirect: HTTP_REDIRECT_DEFAULTS },
  routes: { localhost: "http://127.0.0.1:3000" },
  requireExplicitHost: false,
  allowIps: [] as string[],
} as const;

function normalizeConfig(
  raw: RawProxyConfig | null | undefined,
  baseDir: string
): ProxyConfig {
  const routesEntries = Object.entries(raw?.routes ?? {}).map(([key, value]) => [
    key.trim().toLowerCase(),
    value.trim(),
  ]);
  const routes =
    routesEntries.length > 0 ? Object.fromEntries(routesEntries) : { ...CONFIG_DEFAULTS.routes };

  const rawRedirect = raw?.http?.redirect ?? null;
  const redirect: HttpRedirectConfig = {
    enabled: rawRedirect?.enabled ?? CONFIG_DEFAULTS.http.redirect.enabled,
    port: rawRedirect?.port ?? CONFIG_DEFAULTS.http.redirect.port,
    statusCode: rawRedirect?.statusCode ?? CONFIG_DEFAULTS.http.redirect.statusCode,
  };

  const http = {
    enabled: raw?.http?.enabled ?? CONFIG_DEFAULTS.http.enabled,
    host: raw?.http?.host ?? CONFIG_DEFAULTS.http.host,
    port: raw?.http?.port ?? CONFIG_DEFAULTS.http.port,
    redirect,
  };

  return {
    http,
    routes,
    requireExplicitHost: raw?.requireExplicitHost ?? CONFIG_DEFAULTS.requireExplicitHost,
    allowIps: (raw?.allowIps ?? []).map((item) => item.trim()).filter(Boolean),
    tls: normalizeTls(raw?.tls, baseDir),
    configDir: baseDir,
  };
}

const FALLBACK_CONFIG: ProxyConfig = normalizeConfig(null, process.cwd());

function expandHome(path: string): string {
  if (!path.startsWith("~")) return path;
  const home = Bun.env.HOME ?? Bun.env.USERPROFILE;
  if (!home) return path;
  const remainder = path.slice(1).replace(/^[\\\/]+/, "");
  return remainder ? resolve(home, remainder) : home;
}

function resolveWithBase(path: string, baseDir: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    throw new Error("[proxy] Empty path encountered while resolving TLS configuration.");
  }
  const expanded = expandHome(trimmed);
  return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
}

function normalizeTls(raw: RawTlsConfig | null | undefined, baseDir: string): TlsConfig | null {
  if (!raw) return null;

  const certCandidate = raw.certPath?.trim();
  const keyCandidate = raw.keyPath?.trim();
  const wantsTls =
    raw.enabled ?? Boolean(certCandidate && keyCandidate);

  if (!wantsTls) {
    return null;
  }

  if (!certCandidate || !keyCandidate) {
    throw new Error("[proxy] TLS enabled but certPath or keyPath is missing.");
  }

  const caCandidates = raw.caPath === undefined ? [] : Array.isArray(raw.caPath) ? raw.caPath : [raw.caPath];
  const caPaths = caCandidates
    .map((entry) => entry?.trim())
    .filter((entry): entry is string => Boolean(entry))
    .map((entry) => resolveWithBase(entry, baseDir));

  const certPath = resolveWithBase(certCandidate, baseDir);
  const keyPath = resolveWithBase(keyCandidate, baseDir);
  const passphrase = raw.passphrase?.trim();
  const requestClientCert = Boolean(raw.requestClientCert);

  return {
    enabled: true,
    certPath,
    keyPath,
    caPaths,
    passphrase: passphrase && passphrase.length > 0 ? passphrase : undefined,
    requestClientCert,
  };
}

async function validateTlsFiles(config: ProxyConfig): Promise<void> {
  const tls = config.tls;
  if (!tls) return;

  const candidates = [tls.certPath, tls.keyPath, ...tls.caPaths];
  const checks = candidates.map(async (path) => {
    const file = Bun.file(path);
    if (!(await file.exists())) {
      throw new Error(`[proxy] TLS file not found at ${path}`);
    }
  });

  await Promise.all(checks);
}

function toFileURL(candidate: string | URL): URL {
  if (candidate instanceof URL) return candidate;
  if (candidate.startsWith("file://")) return new URL(candidate);
  const expanded = expandHome(candidate);
  const absolute = isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
  return pathToFileURL(absolute);
}

async function readConfigCandidate(candidate: string | URL): Promise<{ config: ProxyConfig; url: URL } | null> {
  const url = toFileURL(candidate);
  const file = Bun.file(url);
  if (!(await file.exists())) return null;

  try {
    const raw = (await file.json()) as RawProxyConfig;
    const baseDir = dirname(fileURLToPath(url));
    const config = normalizeConfig(raw, baseDir);
    await validateTlsFiles(config);
    return { config, url };
  } catch (err) {
    console.error(`[proxy] Failed to parse config at ${url.pathname}`);
    throw err instanceof Error ? err : new Error(String(err));
  }
}

async function loadConfig(configPath?: string): Promise<ProxyConfig> {
  if (configPath) {
    const explicit = await readConfigCandidate(configPath);
    if (explicit) {
      console.log(`[proxy] Loaded config from ${explicit.url.pathname}`);
      return explicit.config;
    }
    throw new Error(`[proxy] Config file not found at ${toFileURL(configPath).pathname}`);
  }

  const envPath = Bun.env.PROXY_CONFIG ?? Bun.env.REVERSE_PROXY_CONFIG;
  if (envPath) {
    const fromEnv = await readConfigCandidate(envPath);
    if (fromEnv) {
      console.log(`[proxy] Loaded config from ${fromEnv.url.pathname}`);
      return fromEnv.config;
    }
    throw new Error(`[proxy] PROXY_CONFIG points to a missing file: ${envPath}`);
  }

  const search: (string | URL)[] = [
    "proxy.config.json",
    "proxy.config.example.json",
    new URL("../proxy.config.json", import.meta.url),
  ];

  for (const candidate of search) {
    const found = await readConfigCandidate(candidate);
    if (found) {
      console.log(`[proxy] Loaded config from ${found.url.pathname}`);
      return found.config;
    }
  }

  console.warn("[proxy] Falling back to built-in defaults; no config file found.");
  return {
    http: { ...FALLBACK_CONFIG.http },
    routes: { ...FALLBACK_CONFIG.routes },
    requireExplicitHost: FALLBACK_CONFIG.requireExplicitHost,
    allowIps: [...FALLBACK_CONFIG.allowIps],
    tls: FALLBACK_CONFIG.tls ? { ...FALLBACK_CONFIG.tls } : null,
    configDir: FALLBACK_CONFIG.configDir,
  };
}

function pickTarget(config: ProxyConfig, hostHeader: string | null): string {
  const host = (hostHeader ?? "").split(":")[0]?.toLowerCase() ?? "";
  const mapped = config.routes[host];
  if (mapped) return mapped;
  throw new UnknownHostError(host);
}

function isIpAllowed(config: ProxyConfig, ip: string | undefined): boolean {
  if (config.allowIps.length === 0) return true;
  return ip ? config.allowIps.includes(ip) : false;
}

function buildProxiedUrl(targetBase: string, reqUrl: URL): string {
  const base = new URL(targetBase);
  base.pathname = reqUrl.pathname;
  base.search = reqUrl.search;
  return base.toString();
}

async function proxyFetch(req: Request, server: Server, config: ProxyConfig): Promise<Response> {
  const client = server.requestIP(req);
  const clientIP =
    typeof client === "object" && client !== null ? (client.address as string) : undefined;

  if (!isIpAllowed(config, clientIP)) {
    return new Response("Forbidden", { status: 403 });
  }

  let target: string;
  try {
    target = pickTarget(config, req.headers.get("host"));
  } catch (err) {
    if (err instanceof UnknownHostError) {
      if (config.requireExplicitHost) {
        console.error(`[proxy] ${err.message}. Update routes in proxy.config.json.`);
      } else {
        console.warn(`[proxy] ${err.message}.`);
      }
      return new Response("Not Found", { status: 404 });
    }
    console.error("[proxy] target resolution error:", err);
    return new Response("Bad Gateway", { status: 502 });
  }

  const incomingUrl = new URL(req.url);
  const targetUrl = buildProxiedUrl(target, incomingUrl);

  const headers = new Headers(req.headers);
  headers.delete("host");
  headers.set(
    "x-forwarded-for",
    [headers.get("x-forwarded-for"), clientIP].filter(Boolean).join(", ")
  );
  headers.set("x-forwarded-host", req.headers.get("host") ?? "");
  headers.set("x-forwarded-proto", incomingUrl.protocol.replace(":", ""));

  const init: RequestInit = {
    method: req.method,
    headers,
    redirect: "manual",
  };

  if (!["GET", "HEAD"].includes(req.method)) {
    init.body = req.body;
  }

  try {
    const upstreamRes = await fetch(targetUrl, init);
    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      statusText: upstreamRes.statusText,
      headers: upstreamRes.headers,
    });
  } catch (err) {
    console.error("[proxy] upstream error:", err);
    return new Response("Bad Gateway", { status: 502 });
  }
}

function startHttpProxy(config: ProxyConfig) {
  const hostname = config.http.host;
  const port = config.http.port;
  const tlsOptions = config.tls
    ? {
        key: Bun.file(config.tls.keyPath),
        cert: Bun.file(config.tls.certPath),
        ...(config.tls.requestClientCert && config.tls.caPaths.length > 0
          ? { ca: config.tls.caPaths.map((path) => Bun.file(path)) }
          : {}),
        ...(config.tls.requestClientCert ? { requestCert: true } : {}),
        ...(config.tls.passphrase ? { passphrase: config.tls.passphrase } : {}),
      }
    : undefined;

  try {
    const server = Bun.serve({
      hostname,
      port,
      fetch: (req, s) => proxyFetch(req, s, config),
      tls: tlsOptions,
    });
    const scheme = config.tls ? "https" : "http";
    console.log(`🛡️  ${scheme.toUpperCase()} proxy listening at ${scheme}://${hostname}:${port}`);
    return server;
  } catch (err) {
    console.error(
      `[proxy] Failed to bind server at ${hostname}:${port}. If using 80/443, ensure CAP_NET_BIND_SERVICE is enabled and port is free.`,
      err
    );
    throw err;
  }
}

function startHttpRedirect(config: ProxyConfig) {
  const redirect = config.http.redirect;
  if (!redirect.enabled) {
    return undefined;
  }
  if (!config.tls) {
    console.warn("[proxy] HTTP redirect requested but TLS is disabled; skipping redirect listener.");
    return undefined;
  }
  if (redirect.port === config.http.port) {
    console.warn("[proxy] Redirect port matches TLS port; skipping redirect listener to avoid loops.");
    return undefined;
  }

  const hostname = config.http.host;
  const statusCode = redirect.statusCode;
  try {
    const server = Bun.serve({
      hostname,
      port: redirect.port,
      fetch(req) {
        const incoming = new URL(req.url);
        const tlsPort = config.http.port;
        const locationHost = tlsPort === 443 ? incoming.hostname : `${incoming.hostname}:${tlsPort}`;
        const location = `https://${locationHost}${incoming.pathname}${incoming.search}`;
        return new Response(null, {
          status: statusCode,
          headers: {
            location,
          },
        });
      },
    });
    console.log(
      `[proxy] HTTP redirect listening at http://${hostname}:${redirect.port} → https://${hostname}:${config.http.port}`
    );
    return server;
  } catch (err) {
    console.error(
      `[proxy] Failed to bind redirect server at ${hostname}:${redirect.port}.`,
      err
    );
    throw err;
  }
}

export async function runProxy(options: RunOptions = {}) {
  const config = await loadConfig(options.configPath);
  if (config.http.enabled === false) {
    console.warn("[proxy] HTTP proxy disabled by config.");
    return undefined;
  }
  const server = startHttpProxy(config);
  startHttpRedirect(config);
  return server;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    help: false,
    version: false,
    unknown: [],
    configPath: undefined,
    noService: false,
    serviceDryRun: false,
    serviceExtraArgs: [],
    serviceEnv: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) {
      continue;
    }
    const consumeValue = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        throw new Error(`Missing value for ${arg}`);
      }
      i += 1;
      return next;
    };

    switch (arg) {
      case "-c":
      case "--config": {
        options.configPath = consumeValue();
        break;
      }
      case "-h":
      case "--help":
        options.help = true;
        break;
      case "-v":
      case "--version":
        options.version = true;
        break;
      case "--install-service":
        options.installService = true;
        break;
      case "--no-service":
      case "--foreground":
        options.noService = true;
        break;
      case "--service-name":
        options.serviceName = consumeValue();
        break;
      case "--service-user":
        options.serviceUser = consumeValue();
        break;
      case "--service-group":
        options.serviceGroup = consumeValue();
        break;
      case "--service-working-dir":
        options.serviceWorkingDir = consumeValue();
        break;
      case "--service-binary":
      case "--bun-binary":
        options.bunBinary = consumeValue();
        break;
      case "--service-path":
        options.servicePath = consumeValue();
        break;
      case "--service-force":
        options.serviceForce = true;
        break;
      case "--service-no-overwrite":
        options.serviceForce = false;
        break;
      case "--service-dry-run":
        options.serviceDryRun = true;
        break;
      case "--with-cap-net-bind":
        options.serviceCapNetBind = true;
        break;
      case "--service-extra-arg":
        options.serviceExtraArgs.push(consumeValue());
        break;
      case "--service-env":
        options.serviceEnv.push(consumeValue());
        break;
      case "--":
        options.unknown.push(...argv.slice(i + 1));
        i = argv.length;
        break;
      default:
        options.unknown.push(arg);
        break;
    }
  }

  return options;
}

function parseEnvPairs(pairs: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of pairs) {
    const eq = entry.indexOf("=");
    if (eq === -1) {
      throw new Error(`Expected KEY=VALUE but received: ${entry}`);
    }
    const key = entry.slice(0, eq).trim();
    const value = entry.slice(eq + 1).trim();
    if (!key) {
      throw new Error(`Environment key missing in: ${entry}`);
    }
    env[key] = value;
  }
  return env;
}

function printUsage() {
  console.log(`Bun Reverse Proxy ${VERSION}\n`);
  console.log("Usage: reverse-proxy [options]\n");
  console.log("Options:");
  console.log("  -c, --config <path>       Path to proxy.config.json (defaults to CWD)");
  console.log("  -h, --help                Show this message");
  console.log("  -v, --version             Print version");
  console.log("  --install-service         Force systemd installation (default when run as root)");
  console.log("  --no-service, --foreground  Run in foreground even if root");
  console.log("  --service-name <name>     Override systemd unit name (default: reverse-proxy)");
  console.log("  --service-user <user>     Run service as this user (default: SUDO_USER or root)");
  console.log("  --service-group <group>   Run service under this group (default: same as user)");
  console.log("  --service-working-dir <dir>  Working directory for systemd unit (default: config dir)");
  console.log("  --service-path <path>     Override unit file location");
  console.log("  --service-binary <path>   bun executable to use in ExecStart");
  console.log("  --service-extra-arg <arg> Append extra argument to ExecStart (repeatable)");
  console.log("  --with-cap-net-bind       Enable CAP_NET_BIND_SERVICE in systemd unit");
  console.log("  --service-dry-run         Print unit file without writing or calling systemctl");
  console.log("  --service-no-overwrite    Abort if service file already exists");
  console.log("  --service-env KEY=VALUE   Add Environment entry to the unit (repeatable)");
  console.log("\nExamples:");
  console.log("  bun src/index.ts --config ./proxy.config.json");
  console.log("  sudo bunx @ga-ut/reverse-proxy --config /etc/reverse-proxy.json");
  console.log("  sudo bunx @ga-ut/reverse-proxy --config ./proxy.json --no-service");
}

async function main() {
  const args = parseArgs(Bun.argv.slice(2));

  if (args.version) {
    console.log(VERSION);
    return;
  }

  if (args.help) {
    printUsage();
    return;
  }

  if (args.unknown.length > 0) {
    for (const extra of args.unknown) {
      console.warn(`[proxy] Ignoring unknown argument: ${extra}`);
    }
  }

  const runningAsRoot = typeof process.getuid === "function" ? process.getuid() === 0 : false;
  const shouldInstallService = args.installService ?? (runningAsRoot && !args.noService);

  if (shouldInstallService) {
    if (!args.configPath) {
      console.error("[proxy] --config is required when installing as a service.");
      process.exit(1);
    }

    let parsedConfig: ProxyConfig;
    try {
      parsedConfig = await loadConfig(args.configPath);
    } catch (err) {
      console.error("[proxy] Failed to parse config before installing service:", err);
      process.exit(1);
      return;
    }

    let envOverrides: Record<string, string> = {};
    try {
      envOverrides = parseEnvPairs(args.serviceEnv);
    } catch (err) {
      console.error("[proxy] Failed to parse --service-env:", err);
      process.exit(1);
    }

    try {
      await installSystemdService({
        configPath: args.configPath,
        serviceName: args.serviceName,
        serviceUser: args.serviceUser,
        serviceGroup: args.serviceGroup,
        workingDir: args.serviceWorkingDir,
        servicePath: args.servicePath,
        bunBinary: args.bunBinary,
        enableCapNetBind: args.serviceCapNetBind ?? parsedConfig.http.port <= 1024,
        additionalArgs: args.serviceExtraArgs,
        env: envOverrides,
        force: args.serviceForce,
        dryRun: args.serviceDryRun,
      });
    } catch (err) {
      console.error("[proxy] Failed to install systemd service:", err);
      process.exit(1);
    }
    return;
  }

  try {
    await runProxy({ configPath: args.configPath });
  } catch (err) {
    console.error("[proxy] Failed to start proxy:", err);
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}
