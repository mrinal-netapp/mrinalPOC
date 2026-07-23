export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface Logger {
  debug(msg: string, extra?: Record<string, unknown>): void;
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
}

class StructuredLogger implements Logger {
  constructor(
    private readonly service: string,
    private readonly threshold: number,
  ) {}

  private emit(level: LogLevel, msg: string, extra?: Record<string, unknown>): void {
    if (LOG_LEVELS[level] < this.threshold) return;
    const line = JSON.stringify({
      time: new Date().toISOString(),
      level,
      msg,
      service: this.service,
      ...extra,
    });
    process.stdout.write(line + '\n');
  }

  debug(msg: string, extra?: Record<string, unknown>): void {
    this.emit('debug', msg, extra);
  }
  info(msg: string, extra?: Record<string, unknown>): void {
    this.emit('info', msg, extra);
  }
  warn(msg: string, extra?: Record<string, unknown>): void {
    this.emit('warn', msg, extra);
  }
  error(msg: string, extra?: Record<string, unknown>): void {
    this.emit('error', msg, extra);
  }
}

export function getLogger(service: string): Logger {
  const envLevel = (process.env.LOG_LEVEL ?? 'info').toLowerCase() as LogLevel;
  const threshold = LOG_LEVELS[envLevel] ?? LOG_LEVELS.info;
  return new StructuredLogger(service, threshold);
}
