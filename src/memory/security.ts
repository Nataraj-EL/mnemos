import crypto from 'crypto';

// In-memory rate limiter registry
interface RateLimitRecord {
  timestamps: number[];
}

const rateLimitRegistry = new Map<string, RateLimitRecord>();

/**
 * Constant-time comparison helper to mitigate timing attacks on keys.
 * Hashes both parameters using SHA-256 before timingSafeEqual to secure unequal sizes.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  const hashA = crypto.createHmac('sha256', 'mnemos-salt-purity').update(aBuf).digest();
  const hashB = crypto.createHmac('sha256', 'mnemos-salt-purity').update(bBuf).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

/**
 * Resets the in-memory rate limiter registry (useful for testing).
 */
export function resetRateLimits() {
  rateLimitRegistry.clear();
}

/**
 * Sliding window rate limiting helper.
 */
export function checkRateLimit(
  key: string,
  maxRequests: number,
  windowSeconds: number
): { allowed: boolean; remaining: number; resetTime: number } {
  const now = Date.now();
  const windowMs = windowSeconds * 1000;
  const threshold = now - windowMs;

  let record = rateLimitRegistry.get(key);
  if (!record) {
    record = { timestamps: [] };
    rateLimitRegistry.set(key, record);
  }

  // Filter timestamps within the current sliding window
  record.timestamps = record.timestamps.filter((ts) => ts > threshold);

  if (record.timestamps.length >= maxRequests) {
    const oldestTimestamp = record.timestamps[0];
    const resetTime = oldestTimestamp + windowMs;
    return {
      allowed: false,
      remaining: 0,
      resetTime,
    };
  }

  record.timestamps.push(now);
  return {
    allowed: true,
    remaining: maxRequests - record.timestamps.length,
    resetTime: now + windowMs,
  };
}

/**
 * Validates request authentication headers using constant-time string matches.
 */
export function authenticate(headers: Headers): { authenticated: boolean; error?: string } {
  const authEnabled = process.env.MNEMOS_AUTH_ENABLED === 'true';
  if (!authEnabled) {
    return { authenticated: true };
  }

  const expectedKey = process.env.MNEMOS_API_KEY;
  if (!expectedKey) {
    return { authenticated: false, error: 'API key is not configured on the server.' };
  }

  const authHeader = headers.get('Authorization') || '';
  let providedKey = '';
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    providedKey = authHeader.substring(7).trim();
  } else {
    providedKey = (headers.get('X-API-Key') || '').trim();
  }

  if (!providedKey) {
    return { authenticated: false, error: 'Authentication API key is missing.' };
  }

  const matches = timingSafeEqual(providedKey, expectedKey);
  if (!matches) {
    return { authenticated: false, error: 'Authentication API key is invalid.' };
  }

  return { authenticated: true };
}

/**
 * Fast content-length boundary check.
 */
export function checkRequestSize(headers: Headers, maxBytes: number = 100 * 1024): boolean {
  const contentLengthStr = headers.get('content-length');
  if (contentLengthStr) {
    const contentLength = Number(contentLengthStr);
    if (!isNaN(contentLength) && contentLength > maxBytes) {
      return false;
    }
  }
  return true;
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validates parameters for ingestion.
 */
export function validateIngestInput(userId: unknown, content: unknown): ValidationResult {
  if (typeof userId !== 'string' || !userId.trim()) {
    return { valid: false, error: 'Missing or invalid parameter: userId is required.' };
  }
  if (userId.length > 128) {
    return { valid: false, error: 'Invalid parameter: userId cannot exceed 128 characters.' };
  }

  if (typeof content !== 'string' || !content.trim()) {
    return { valid: false, error: 'Missing or invalid parameter: content is required.' };
  }
  if (content.length > 10000) {
    return { valid: false, error: 'Invalid parameter: content cannot exceed 10,000 characters.' };
  }

  return { valid: true };
}

/**
 * Validates search, context assembly, and query response parameters.
 */
export function validateQueryInput(
  userId: unknown,
  query: unknown,
  limit?: unknown,
  maxTokens?: unknown
): ValidationResult {
  if (typeof userId !== 'string' || !userId.trim()) {
    return { valid: false, error: 'Missing or invalid parameter: userId is required.' };
  }
  if (userId.length > 128) {
    return { valid: false, error: 'Invalid parameter: userId cannot exceed 128 characters.' };
  }

  if (typeof query !== 'string' || !query.trim()) {
    return { valid: false, error: 'Missing or invalid parameter: query is required.' };
  }
  if (query.length > 10000) {
    return { valid: false, error: 'Invalid parameter: query cannot exceed 10,000 characters.' };
  }

  if (limit !== undefined) {
    const limitNum = Number(limit);
    if (isNaN(limitNum) || !Number.isInteger(limitNum) || limitNum <= 0 || limitNum > 100) {
      return {
        valid: false,
        error: 'Invalid parameter: limit must be an integer between 1 and 100.',
      };
    }
  }

  if (maxTokens !== undefined) {
    const tokensNum = Number(maxTokens);
    if (
      isNaN(tokensNum) ||
      !Number.isInteger(tokensNum) ||
      tokensNum <= 0 ||
      tokensNum > 100000
    ) {
      return {
        valid: false,
        error: 'Invalid parameter: maxTokens must be an integer between 1 and 100,000.',
      };
    }
  }

  return { valid: true };
}
