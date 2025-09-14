import type { Server } from "bun";

type HostMap = Record<string, string>;

interface ProxyConfig {
  http?: {
    enabled?: boolean;
    host?: string;
    port?: number;
  };
  routes: HostMap;
  requireExplicitHost?: boolean;
  allowIps?: string[];
}

class UnknownHostError extends Error {
  constructor(public readonly host: string) {
    super(`No proxy target configured for host: ${host}`);
    this.name = "UnknownHostError";
  }
}

async function loadConfig(): Promise<ProxyConfig> {
  try {
    // Expect config at ../proxy.config.json next to this src/
    const url = new URL("../proxy.config.json", import.meta.url);
    const cfg = (await Bun.file(url).json()) as ProxyConfig;
    const normalized: ProxyConfig = {
      http: {
        enabled: cfg.http?.enabled ?? true,
        host: cfg.http?.host ?? "0.0.0.0",
        port: cfg.http?.port ?? 80,
      },
      routes: Object.fromEntries(
        Object.entries(cfg.routes ?? {}).map(([k, v]) => [
          k.trim().toLowerCase(),
          v.trim(),
        ])
      ),
      requireExplicitHost: cfg.requireExplicitHost ?? false,
      allowIps: (cfg.allowIps ?? []).map((s) => s.trim()).filter(Boolean),
    };
    return normalized;
  } catch (err) {
    console.warn(
      "[proxy] Failed to load proxy.config.json, using defaults.",
      err
    );
    return {
      http: { enabled: true, host: "0.0.0.0", port: 80 },
      routes: { localhost: "http://127.0.0.1:3000" },
      requireExplicitHost: false,
      allowIps: [],
    };
  }
}

const CONFIG = await loadConfig();

function pickTarget(hostHeader: string | null): string {
  const host = (hostHeader ?? "").split(":")[0]?.toLowerCase() ?? "";
  const mapped = CONFIG.routes[host];
  if (mapped) return mapped;
  throw new UnknownHostError(host);
}

function isIpAllowed(ip: string | undefined): boolean {
  const allow = CONFIG.allowIps ?? [];
  if (allow.length === 0) return true;
  return ip ? allow.includes(ip) : false;
}

function buildProxiedUrl(targetBase: string, reqUrl: URL): string {
  const base = new URL(targetBase);
  base.pathname = reqUrl.pathname;
  base.search = reqUrl.search;
  return base.toString();
}

async function proxyFetch(req: Request, server: Server): Promise<Response> {
  const client = server.requestIP(req);
  const clientIP =
    typeof client === "object" && client !== null
      ? (client.address as string)
      : undefined;
  if (!isIpAllowed(clientIP)) {
    return new Response("Forbidden", { status: 403 });
  }

  let target: string;
  try {
    target = pickTarget(req.headers.get("host"));
  } catch (err) {
    if (err instanceof UnknownHostError) {
      console.error(
        `[proxy] ${err.message}. Update routes in proxy.config.json.`
      );
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

function startHttpProxy() {
  const hostname = CONFIG.http?.host ?? "0.0.0.0";
  const port = CONFIG.http?.port ?? 80;
  try {
    const server = Bun.serve({
      hostname,
      port,
      fetch: (req, s) => proxyFetch(req, s),
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

if (CONFIG.http?.enabled !== false) {
  startHttpProxy();
} else {
  console.warn("[proxy] HTTP proxy disabled by config.");
}
