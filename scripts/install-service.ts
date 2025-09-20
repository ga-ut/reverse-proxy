#!/usr/bin/env bun

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { $ } from "bun";

interface CliOptions {
  serviceName: string;
  servicePath?: string;
  user?: string;
  group?: string;
  workingDir?: string;
  bunBinary?: string;
  entry?: string;
  env: Record<string, string>;
  enableCapNetBind: boolean;
  enableService: boolean;
  startService: boolean;
  dryRun: boolean;
  force: boolean;
  skipReload: boolean;
}

const HELP = `Usage: bun scripts/install-service.ts [options]

Options:
  --service-name <name>         Systemd service name (default: reverse-proxy)
  --service-path <path>         Override systemd unit file path (default: /etc/systemd/system/<name>.service)
  --user <user>                 Linux user that runs the service (required)
  --group <group>               Linux group (default: same as --user)
  --working-dir <dir>           Working directory for the service (default: current directory)
  --bun-binary <path>           Bun binary path used in ExecStart (default: /usr/bin/env bun)
  --entry <file>                Entry point passed to Bun (default: src/index.ts)
  --env KEY=VALUE               Inject additional Environment entries (repeatable)
  --enable-cap-net-bind         Add CAP_NET_BIND_SERVICE capabilities (for ports 80/443)
  --no-enable                   Skip systemctl enable
  --start                       Start (or restart) the service after installation
  --no-reload                   Skip systemctl daemon-reload step
  --dry-run                     Print unit file without writing or calling systemctl
  --force                       Overwrite existing service file if present
  --help                        Show this message
`;

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    serviceName: "reverse-proxy",
    env: {},
    enableCapNetBind: false,
    enableService: true,
    startService: false,
    dryRun: false,
    force: false,
    skipReload: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const rawArg = argv[i];
    if (rawArg === undefined) {
      continue; // satisfies noUncheckedIndexedAccess
    }
    const arg = rawArg;
    if (arg === "--help" || arg === "-h") {
      console.log(HELP);
      process.exit(0);
    }

    if (!arg.startsWith("--")) {
      console.error(`Unknown argument: ${arg}`);
      console.log(HELP);
      process.exit(1);
    }

    const [flag, inlineValue] = arg.split("=", 2);

    const consumeValue = () => {
      if (inlineValue !== undefined) return inlineValue;
      const next = argv[++i];
      if (!next || next.startsWith("--")) {
        console.error(`Missing value for ${flag}`);
        process.exit(1);
      }
      return next;
    };

    switch (flag) {
      case "--service-name":
        options.serviceName = consumeValue();
        break;
      case "--service-path":
        options.servicePath = consumeValue();
        break;
      case "--user":
        options.user = consumeValue();
        break;
      case "--group":
        options.group = consumeValue();
        break;
      case "--working-dir":
        options.workingDir = consumeValue();
        break;
      case "--bun-binary":
        options.bunBinary = consumeValue();
        break;
      case "--entry":
        options.entry = consumeValue();
        break;
      case "--env": {
        const value = consumeValue();
        const eq = value.indexOf("=");
        if (eq === -1) {
          console.error(`--env expects KEY=VALUE but received: ${value}`);
          process.exit(1);
        }
        const key = value.slice(0, eq).trim();
        const val = value.slice(eq + 1).trim();
        if (!key) {
          console.error(`Environment key missing in: ${value}`);
          process.exit(1);
        }
        options.env[key] = val;
        break;
      }
      case "--enable-cap-net-bind":
        options.enableCapNetBind = true;
        break;
      case "--no-enable":
        options.enableService = false;
        break;
      case "--start":
        options.startService = true;
        break;
      case "--no-reload":
        options.skipReload = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--force":
        options.force = true;
        break;
      default:
        console.error(`Unknown option: ${flag}`);
        console.log(HELP);
        process.exit(1);
    }
  }

  return options;
}

function ensureRootAccess(target: string) {
  if (process.platform !== "linux") {
    console.warn("This script is intended for Linux hosts running systemd.");
  }

  if (process.getuid && process.getuid() !== 0 && target.startsWith("/")) {
    console.warn(
      `Warning: writing to ${target} usually requires root privileges.`
    );
  }
}

function quoteEnvEntry(key: string, value: string): string {
  const pair = `${key}=${value}`;
  if (/[\s"']/u.test(pair)) {
    const escaped = pair.replace(/"/g, '\\"');
    return `Environment="${escaped}"`;
  }
  return `Environment=${pair}`;
}

function buildUnitFile(
  opts: Required<Omit<CliOptions, "servicePath" | "env">> & {
    servicePath: string;
    env: Record<string, string>;
  }
): string {
  const envEntries: string[] = [];
  for (const [key, value] of Object.entries(opts.env)) {
    envEntries.push(quoteEnvEntry(key, value));
  }

  const envBlock = envEntries.length ? envEntries.join("\n") : "Environment=NODE_ENV=production";

  const capLines = opts.enableCapNetBind
    ? [
        "# Allow binding to privileged ports",
        "AmbientCapabilities=CAP_NET_BIND_SERVICE",
        "CapabilityBoundingSet=CAP_NET_BIND_SERVICE",
        "NoNewPrivileges=true",
      ]
    : [];

  const capBlock = capLines.length ? `${capLines.join("\n")}\n` : "";

  return `# Auto-generated by scripts/install-service.ts
# Service: ${opts.serviceName}

[Unit]
Description=Bun Reverse Proxy (host-based HTTP router)
Wants=network-online.target
After=network-online.target

[Service]
User=${opts.user}
Group=${opts.group}
WorkingDirectory=${opts.workingDir}

${envBlock}

ExecStart=${opts.bunBinary} ${opts.entry}
Restart=always
RestartSec=2
KillSignal=SIGINT
TimeoutStopSec=15
SyslogIdentifier=${opts.serviceName}
${capBlock}LimitNOFILE=65536
ProtectSystem=full
ProtectHome=false
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
LockPersonality=true

[Install]
WantedBy=multi-user.target
`;
}

async function main() {
  const options = parseArgs(Bun.argv.slice(2));

  if (!options.user) {
    console.error("--user is required");
    console.log(HELP);
    process.exit(1);
  }

  if (!options.group) {
    options.group = options.user;
  }

  if (!options.bunBinary) {
    options.bunBinary = "/usr/bin/env bun";
  }

  if (!options.entry) {
    options.entry = "src/index.ts";
  }

  if (!options.workingDir) {
    options.workingDir = process.cwd();
  }

  const defaults: Record<string, string> = {
    NODE_ENV: "production",
    PATH: `/home/${options.user}/.bun/bin:/usr/local/bin:/usr/bin`,
  };
  options.env = { ...defaults, ...options.env };

  const servicePath =
    options.servicePath ?? `/etc/systemd/system/${options.serviceName}.service`;

  ensureRootAccess(servicePath);

  const unitFile = buildUnitFile({
    serviceName: options.serviceName,
    servicePath,
    user: options.user,
    group: options.group,
    workingDir: options.workingDir,
    bunBinary: options.bunBinary,
    entry: options.entry,
    env: options.env,
    enableCapNetBind: options.enableCapNetBind,
    enableService: options.enableService,
    startService: options.startService,
    dryRun: options.dryRun,
    force: options.force,
    skipReload: options.skipReload,
  });

  if (options.dryRun) {
    console.log(unitFile);
    return;
  }

  mkdirSync(dirname(servicePath), { recursive: true });

  if (!options.force) {
    try {
      await Bun.file(servicePath).text();
      console.error(
        `Refusing to overwrite existing file at ${servicePath}. Use --force to override.`
      );
      process.exit(1);
    } catch {
      // file does not exist - continue
    }
  }

  await Bun.write(servicePath, unitFile);
  await $`chmod 644 ${servicePath}`;

  if (!options.skipReload) {
    try {
      await $`systemctl daemon-reload`;
    } catch (error) {
      console.error("Failed to run systemctl daemon-reload:", error);
      console.error(
        "You may need to rerun this command with sudo/root privileges."
      );
      process.exit(1);
    }
  }

  if (options.enableService) {
    try {
      await $`systemctl enable ${options.serviceName}`;
    } catch (error) {
      console.error(`Failed to enable service ${options.serviceName}:`, error);
      console.error(
        "You may need to rerun this command with sudo/root privileges."
      );
      process.exit(1);
    }
  }

  if (options.startService) {
    try {
      await $`systemctl restart ${options.serviceName}`;
    } catch (error) {
      console.error(`Failed to start service ${options.serviceName}:`, error);
      console.error(
        "You may need to rerun this command with sudo/root privileges."
      );
      process.exit(1);
    }
  }

  console.log(`Installed ${options.serviceName} at ${servicePath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
