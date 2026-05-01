/**
 * Tiny namespaced logger. Honors HA_HERMES_BRIDGE_DEBUG=1 for verbose output.
 * Adapted from openclaw-HelloAgent/src/core/ha-logger.ts.
 */

const DEBUG = process.env.HA_HERMES_BRIDGE_DEBUG === "1";

export type LogFn = (msg: string, fields?: Record<string, unknown>) => void;

export type Logger = {
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  debug: LogFn;
};

function emit(level: string, ns: string, msg: string, fields?: Record<string, unknown>): void {
  const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
  const ts = new Date().toISOString();
  let line = `${ts} ${level.toUpperCase()} [${ns}] ${msg}`;
  if (fields && Object.keys(fields).length > 0) {
    line += " " + JSON.stringify(fields);
  }
  stream.write(line + "\n");
}

export function logger(ns: string): Logger {
  return {
    info: (msg, fields) => emit("info", ns, msg, fields),
    warn: (msg, fields) => emit("warn", ns, msg, fields),
    error: (msg, fields) => emit("error", ns, msg, fields),
    debug: (msg, fields) => {
      if (DEBUG) emit("debug", ns, msg, fields);
    },
  };
}
