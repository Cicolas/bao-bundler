const VERBOSITY_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 } as const;
type VerbosityLevel = keyof typeof VERBOSITY_LEVELS;

const LEVEL_COLORS: Record<VerbosityLevel, string> = {
  DEBUG: '\x1b[90m', // gray
  INFO: '\x1b[36m',  // cyan
  WARN: '\x1b[33m',  // yellow
  ERROR: '\x1b[31m', // red
};
const RESET = '\x1b[0m';

export const Logger = {
  verbosityLevel: (() => {
    const val = process.env.BAO_VERBOSITY?.toUpperCase() ?? 'DEBUG';
    return (val in VERBOSITY_LEVELS ? val : 'DEBUG') as VerbosityLevel;
  })(),

  _log(level: VerbosityLevel, ...args: any[]) {
    if (VERBOSITY_LEVELS[level] >= VERBOSITY_LEVELS[this.verbosityLevel]) {
      const color = LEVEL_COLORS[level];
      const colorMsg = level === 'INFO' ? RESET : color;
      console.log(`${color}${level}${RESET}: ${colorMsg}[Bao Bundler] ${args}${RESET}`);
    }
  },
  info(...args: any[]) { this._log('INFO', ...args); },
  warn(...args: any[]) { this._log('WARN', ...args); },
  error(...args: any[]) { this._log('ERROR', ...args); },
  debug(...args: any[]) { this._log('DEBUG', ...args); },
};
