export interface Logger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  debug(msg: string, data?: Record<string, unknown>): void;
}

export function createLogger(server: string): Logger {
  const log = (level: string, msg: string, data?: Record<string, unknown>) => {
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      server,
      msg,
      ...data,
    });
    process.stderr.write(entry + "\n");
  };

  return {
    info: (msg, data) => log("info", msg, data),
    warn: (msg, data) => log("warn", msg, data),
    error: (msg, data) => log("error", msg, data),
    debug: (msg, data) => log("debug", msg, data),
  };
}
