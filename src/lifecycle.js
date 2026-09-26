// -----------------------------------------------------------------------------
// Process lifecycle helpers: retry of the post-connection initialization, and
// the last-resort handler for promise rejections nobody caught.
//
// Borrowed from ../gladys-iss/src/lifecycle.js. The SDK reconnects the
// WebSocket by itself, but it does not retry OUR setup (reading the config
// from the host API): without a retry, one failure at boot (Gladys still
// starting) leaves the integration idle until the WebSocket happens to drop.
// Timers are injectable, like in poller.js.
// -----------------------------------------------------------------------------

export const DEFAULT_MIN_RETRY_DELAY_MS = 30 * 1000;
export const DEFAULT_MAX_RETRY_DELAY_MS = 30 * 60 * 1000;

/**
 * Runs an async initialization and, while it fails, retries it with a capped
 * exponential backoff plus jitter. A single retry loop: `start()` cancels any
 * pending retry, and the outcome of an attempt superseded by a newer `start()`
 * (or by `stop()`) is ignored.
 */
export class InitRetry {
  /**
   * @param {object} deps
   * @param {() => Promise<void>} deps.run - The initialization; throws on failure.
   * @param {(err: Error, delayMs: number) => void} deps.onFailure - Called after each failed attempt, with the delay before the next one.
   * @param {number} [deps.minDelayMs] - Delay before the first retry (before jitter).
   * @param {number} [deps.maxDelayMs] - Delay cap (before jitter).
   * @param {() => number} [deps.random] - Injectable jitter source, for tests.
   * @param {typeof setTimeout} [deps.setTimer] - Injectable timer, for tests.
   * @param {typeof clearTimeout} [deps.clearTimer] - Injectable timer, for tests.
   */
  constructor({
    run,
    onFailure,
    minDelayMs = DEFAULT_MIN_RETRY_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_RETRY_DELAY_MS,
    random = Math.random,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  }) {
    this.run = run;
    this.onFailure = onFailure;
    this.minDelayMs = minDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.random = random;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.timer = null;
    this.failures = 0;
    this.generation = 0;
  }

  /**
   * Cancel any pending retry, reset the backoff and run an attempt now.
   * @returns {Promise<void>} Settles once this attempt succeeded or its retry is scheduled.
   * @example
   * gladys.on('connected', () => initRetry.start());
   */
  start() {
    this.stop();
    this.failures = 0;
    return this.attempt(this.generation);
  }

  /**
   * Cancel the pending retry; an attempt still in flight will not schedule one.
   * @returns {void}
   * @example
   * initRetry.stop();
   */
  stop() {
    this.generation += 1;
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  async attempt(generation) {
    try {
      await this.run();
    } catch (err) {
      if (generation !== this.generation) {
        return;
      }
      // Equal jitter: somewhere in the upper half of the backoff delay.
      const backoffMs = Math.min(this.minDelayMs * 2 ** this.failures, this.maxDelayMs);
      const delayMs = Math.round(backoffMs / 2 + (this.random() * backoffMs) / 2);
      this.failures += 1;
      this.timer = this.setTimer(() => {
        this.timer = null;
        return this.attempt(generation);
      }, delayMs);
      this.onFailure(err, delayMs);
    }
  }
}

/**
 * Last-resort handler: log a rejection nobody caught, then exit so the Gladys
 * supervisor restarts the integration in a clean state (the process may be
 * inconsistent after it).
 * @param {object} deps
 * @param {{error: Function}} deps.logger - Where to log the rejection.
 * @param {(code: number) => void} [deps.exit] - Injectable for tests.
 * @param {NodeJS.EventEmitter} [deps.processRef] - Injectable for tests.
 * @returns {void}
 * @example
 * exitOnUnhandledRejection({ logger });
 */
export function exitOnUnhandledRejection({
  logger,
  exit = (code) => process.exit(code),
  processRef = process,
}) {
  processRef.on('unhandledRejection', (reason) => {
    logger.error(
      'Unhandled promise rejection, exiting so the integration restarts cleanly',
      reason,
    );
    exit(1);
  });
}
