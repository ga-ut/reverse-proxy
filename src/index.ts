import type { Server } from "bun";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pkgJson from "../package.json" assert { type: "json" };

type HostMap = Record<string, string>;

interface RawProxyConfig {
  http?: {
    enabled?: boolean;
    host?: string;
    port?: number;
  };
  routes?: HostMap;
  requireExplicitHost?: boolean;
  allowIps?: string[];
}

interface ProxyConfig {
  http: {
    enabled: boolean;
    host: string;
    port: number;
  };
  routes: HostMap;
  requireExplicitHost: boolean;
  allowIps: string[];
}

interface RunOptions {
  configPath?: string;
}

interface CliOptions extends RunOptions {
  help: boolean;
  version: boolean;
  unknown: string[];
}

class UnknownHostError extends Error {
  constructor(public readonly host: string) {
    super(`No proxy target configured for host: ${host}`);
    this.name = "UnknownHostError";
  }
}

const VERSION = (pkgJson as { version?: string }).version ?? "0.0.0";

const FALLBACK_CONFIG: ProxyConfig = normalizeConfig({
  http: { enabled: true, host: "0.0.0.0", port: 80 },
  routes: { localhost: "http://127.0.0.1:3000" },
  requireExplicitHost: false,
  allowIps: [],
});

function normalizeConfig(raw: RawProxyConfig | null | undefined): ProxyConfig {
  const routesEntries = Object.entries(raw?.routes ?? {}).map(([key, value]) => [
    key.trim().toLowerCase(),
    value.trim(),
  ]);
  const routes = routesEntries.length > 0 ? Object.fromEntries(routesEntries) : { ...FALLBACK_CONFIG.routes };

  return {
    http: {
      enabled: raw?.http?.enabled ?? FALLBACK_CONFIG.http.enabled,
      host: raw?.http?.host ?? FALLBACK_CONFIG.http.host,
      port: raw?.http?.port ?? FALLBACK_CONFIG.http.port,
    },
    routes,
    requireExplicitHost: raw?.requireExplicitHost ?? FALLBACK_CONFIG.requireExplicitHost,
    allowIps: (raw?.allowIps ?? []).map((item) => item.trim()).filter(Boolean),
  };
}

function expandHome(path: string): string {
  if (!path.startsWith("~")) return path;
  const home = Bun.env.HOME ?? Bun.env.USERPROFILE;
  if (!home) return path;
  const remainder = path.slice(1).replace(/^[\\\/]+/, "");
  return remainder ? resolve(home, remainder) : home;
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
    return { config: normalizeConfig(raw), url };
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
  try {
    const server = Bun.serve({
      hostname,
      port,
      fetch: (req, s) => proxyFetch(req, s, config),
    });
    console.log(`🛡️  HTTP proxy listening at http://${hostname}:${port}`);
    return server;
  } catch (err) {
    console.error(
      `[proxy] Failed to bind server at ${hostname}:${port}. If using 80/443, ensure CAP_NET_BIND_SERVICE is enabled and port is free.`,
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
  return startHttpProxy(config);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { help: false, version: false, unknown: [], configPath: undefined };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) {
      continue;
    }
    switch (arg) {
      case "-c":
      case "--config": {
        const next = argv[i + 1];
        if (!next || next.startsWith("-")) {
          throw new Error("Missing value for --config");
        }
        options.configPath = next;
        i += 1;
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

function printUsage() {
  console.log(`Bun Reverse Proxy ${VERSION}\n`);
  console.log("Usage: reverse-proxy [options]\n");
  console.log("Options:");
  console.log("  -c, --config <path>   Path to proxy.config.json (defaults to CWD)");
  console.log("  -h, --help            Show this message");
  console.log("  -v, --version         Print version");
  console.log("\nExamples:");
  console.log("  bun src/index.ts --config ./proxy.config.json");
  console.log("  bunx @ga-ut/reverse-proxy --config ./proxy.config.json");
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
