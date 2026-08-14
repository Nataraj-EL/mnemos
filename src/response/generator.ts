export interface ResponseGeneratorResult {
  text: string;
  metadata?: Record<string, unknown>;
}

export interface ResponseGenerator {
  generateResponse(
    query: string,
    context: string,
    config?: Record<string, unknown>
  ): Promise<ResponseGeneratorResult>;
}
