/** 写到 stderr 的日志，行格式与原项目的 loguru 一致：`2026-10-13 01:23:26.491 | INFO     | 模块 - 消息`。 */
type Level = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';
const ORDER: Record<Level, number> = { DEBUG: 10, INFO: 20, WARNING: 30, ERROR: 40 };

let threshold: Level = 'INFO';
export function setLogLevel(level: Level): void {
  threshold = level;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function stamp(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warning(msg: string): void;
  error(msg: string): void;
}

export function getLogger(module: string): Logger {
  const write = (level: Level, msg: string) => {
    if (ORDER[level] < ORDER[threshold]) return;
    process.stderr.write(`${stamp()} | ${level.padEnd(8)} | ${module} - ${msg}\n`);
  };
  return {
    debug: (m) => write('DEBUG', m),
    info: (m) => write('INFO', m),
    warning: (m) => write('WARNING', m),
    error: (m) => write('ERROR', m),
  };
}
