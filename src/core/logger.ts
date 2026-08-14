export interface LogTelemetry {
  correlationId: string;
  retrievalLatencyMs?: number;
  candidateCount?: number;
  selectedCount?: number;
  estimatedContextTokens?: number;
  generationLatencyMs?: number;
  totalLatencyMs?: number;
  model?: string;
  status: 'success' | 'error';
  errorCategory?: string;
}

/**
 * Privacy-first structured JSON logger.
 * Captures query metadata and pipeline performance without storing sensitive contents
 * like user queries, prompts, or LLM response text.
 */
export function logTelemetry(data: LogTelemetry) {
  const logPayload = {
    timestamp: new Date().toISOString(),
    ...data,
  };
  // Print structured JSON safely to console.log
  console.log(JSON.stringify(logPayload));
}
