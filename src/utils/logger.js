const Levels = {
  SILENT: 0,
  ERROR: 1,
  WARN: 2,
  INFO: 3,
  DEBUG: 4,
};

// Pick initial log level:
// 1. From process.env.LOG_LEVEL (error|warn|info|debug|silent)
// 2. Fallback to DEBUG in development, INFO otherwise
const initialLevelName = process.env.LOG_LEVEL && process.env.LOG_LEVEL.toUpperCase();
let currentLevel =
  Levels[initialLevelName] !== undefined
    ? Levels[initialLevelName]
    : process.env.NODE_ENV === 'production'
    ? Levels.INFO
    : Levels.DEBUG;

function log(level, method, args) {
  if (level <= currentLevel) {
    // eslint-disable-next-line no-console
    console[method](...args);
  }
}

const logger = {
  setLevel(levelName = 'INFO') {
    const upper = levelName.toUpperCase();
    if (Levels[upper] !== undefined) {
      currentLevel = Levels[upper];
    } else {
      // eslint-disable-next-line no-console
      console.warn(`Logger: unknown level "${levelName}" – keeping", current level`);
    }
  },
  error: (...args) => log(Levels.ERROR, 'error', args),
  warn: (...args) => log(Levels.WARN, 'warn', args),
  info: (...args) => log(Levels.INFO, 'info', args),
  debug: (...args) => log(Levels.DEBUG, 'debug', args),
};

module.exports = { logger, Levels }; 