/** 默认写到 stderr，行格式与原项目的 loguru 一致：`2026-10-13 01:23:26.491 | INFO     | 模块 - 消息`。 */
export type Level = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';
const ORDER: Record<Level, number> = { DEBUG: 10, INFO: 20, WARNING: 30, ERROR: 40 };

/** 日志去向：作为库嵌入别的程序时，用 setLogSink 接到宿主自己的日志系统。 */
export type LogSink = (level: Level, module: string, msg: string) => void;

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function stamp(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

const stderrSink: LogSink = (level, module, msg) => {
  process.stderr.write(`${stamp()} | ${level.padEnd(8)} | ${module} - ${msg}\n`);
};

let threshold: Level = 'INFO';
let sink: LogSink = stderrSink;

export function setLogLevel(level: Level): void {
  threshold = level;
}

/** 换掉日志去向，返回原来的；级别过滤仍由 setLogLevel 决定，宿主要自己过滤时把级别设为 DEBUG。 */
export function setLogSink(next: LogSink): LogSink {
  const prev = sink;
  sink = next;
  return prev;
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
    sink(level, module, msg);
  };
  return {
    debug: (m) => write('DEBUG', m),
    info: (m) => write('INFO', m),
    warning: (m) => write('WARNING', m),
    error: (m) => write('ERROR', m),
  };
}
