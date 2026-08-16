export interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;
  jitter?: boolean;
  signal?: AbortSignal;
  random?: () => number;
  onRetry?: (attempt: number, error: Error) => void;
}

export class ResilienceTracker {
  private retryCount = 0;
  private finalOutcome: 'success' | 'failure' = 'success';
  private failureCategory?: string;

  public incrementRetries(): void {
    this.retryCount++;
  }

  public getRetryCount(): number {
    return this.retryCount;
  }

  public setOutcome(outcome: 'success' | 'failure'): void {
    this.finalOutcome = outcome;
  }

  public getOutcome(): 'success' | 'failure' {
    return this.finalOutcome;
  }

  public setFailureCategory(category: string): void {
    this.failureCategory = category;
  }

  public getFailureCategory(): string | undefined {
    return this.failureCategory;
  }
}

export function isTransientError(error: unknown): boolean {
  if (!error || !(error instanceof Error)) return false;

  const msg = error.message.toLowerCase();

  // Abort / Cancellation is never retryable
  if (
    msg.includes('abort') ||
    msg.includes('cancel') ||
    error.name === 'AbortError'
  ) {
    return false;
  }

  // Parse HTTP status codes
  const httpMatch = error.message.match(/HTTP (\d+)/i);
  if (httpMatch) {
    const status = parseInt(httpMatch[1], 10);
    // 408 (Timeout), 429 (Too Many Requests), 5xx are transient
    if (status === 408 || status === 429 || (status >= 500 && status < 600)) {
      return true;
    }
    return false;
  }

  // Postgres specific error code classification
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pgCode = (error as any).code;
  if (typeof pgCode === 'string') {
    // Class 08: Connection Exception
    // Class 57: Operator Intervention (admin shutdown / database shutdown)
    // Class 40: Transaction Rollback (deadlock, serialization failure)
    const category = pgCode.substring(0, 2);
    if (category === '08' || category === '57' || category === '40') {
      return true;
    }
    return false;
  }

  // General TCP/Network and Timeout error messages
  const transientKeywords = [
    'fetch failed',
    'econnreset',
    'etimedout',
    'network error',
    'timeout',
    'socket hang up',
    'connection error',
    'rate limit',
    'throttled',
    'service unavailable',
    'bad gateway',
    'gateway timeout',
    'deadlock',
    'connection refused'
  ];

  if (transientKeywords.some(keyword => msg.includes(keyword))) {
    return true;
  }

  return false;
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  options?: RetryOptions
): Promise<T> {
  const maxAttempts = options?.maxAttempts ?? 3;
  const initialDelayMs = options?.initialDelayMs ?? 500;
  const maxDelayMs = options?.maxDelayMs ?? 3000;
  const backoffFactor = options?.backoffFactor ?? 2;
  const jitter = options?.jitter ?? true;
  const signal = options?.signal;
  const random = options?.random ?? Math.random;

  let attempt = 0;
  while (true) {
    attempt++;
    try {
      if (signal?.aborted) {
        throw new Error('AbortError');
      }
      return await operation();
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));

      if (signal?.aborted || err.message.includes('aborted') || err.name === 'AbortError') {
        throw err;
      }

      if (attempt >= maxAttempts || !isTransientError(err)) {
        throw err;
      }

      if (options?.onRetry) {
        options.onRetry(attempt, err);
      }

      // Calculate delay: use Retry-After if available, else exponential backoff
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const retryAfterMs = (err as any).retryAfterMs;
      let delay = typeof retryAfterMs === 'number' && retryAfterMs > 0
        ? retryAfterMs
        : initialDelayMs * Math.pow(backoffFactor, attempt - 1);

      // Apply random jitter only to normal backoffs (between 50% and 100% of delay)
      if (jitter && typeof retryAfterMs !== 'number') {
        delay = (0.5 + random() * 0.5) * delay;
      }

      // Enforce max delay cap after jitter is applied
      if (delay > maxDelayMs) {
        delay = maxDelayMs;
      }

      // Wait with AbortSignal cancellation support
      await new Promise<void>((resolve, reject) => {
        let timeoutId: NodeJS.Timeout | undefined = undefined;
        const onAbort = () => {
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
          reject(new Error('AbortError'));
        };

        if (signal?.aborted) {
          return reject(new Error('AbortError'));
        }

        if (signal) {
          signal.addEventListener('abort', onAbort);
        }

        timeoutId = setTimeout(() => {
          if (signal) {
            signal.removeEventListener('abort', onAbort);
          }
          resolve();
        }, delay);
      });
    }
  }
}
