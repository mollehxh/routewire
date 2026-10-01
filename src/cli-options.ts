export interface CliOptions {
  host: string;
  port: number;
  model: string;
  dangerFullAccess: boolean;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function parseCliOptions(args: string[]): CliOptions {
  const options: CliOptions = {
    host: "127.0.0.1",
    port: 0,
    model: "gpt-5.6-sol",
    dangerFullAccess: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--danger-full-access") {
      options.dangerFullAccess = true;
      continue;
    }

    if (arg === "--host" || arg === "--port" || arg === "--model") {
      const value = args[index + 1];
      if (!value) throw new Error(`Missing value for ${arg}`);
      index += 1;

      if (arg === "--host") options.host = value;
      if (arg === "--model") options.model = value;
      if (arg === "--port") {
        const port = Number(value);
        if (!Number.isInteger(port) || port < 0 || port > 65_535) {
          throw new Error(`Invalid port: ${value}`);
        }
        options.port = port;
      }
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  if (!LOOPBACK_HOSTS.has(options.host)) {
    throw new Error(`Sideband only binds loopback addresses; received host ${options.host}`);
  }

  return options;
}
