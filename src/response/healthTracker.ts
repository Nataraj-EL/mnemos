export interface HealthSummary {
  memoryRetrievalSuccess?: boolean;
  conversationRetrievalSuccess?: boolean;
  memoryCacheHit?: boolean;
  conversationCacheHit?: boolean;
  memoryFallbackUsed?: boolean;
  conversationFallbackUsed?: boolean;
  retryOccurred: boolean;
  timeoutOccurred: boolean;
  latencyAvailable: boolean;
}

export class HealthTracker {
  private memoryRetrievalSuccess?: boolean = undefined;
  private conversationRetrievalSuccess?: boolean = undefined;
  private memoryCacheHit?: boolean = undefined;
  private conversationCacheHit?: boolean = undefined;
  private memoryFallbackUsed?: boolean = undefined;
  private conversationFallbackUsed?: boolean = undefined;
  private retryOccurred = false;
  private timeoutOccurred = false;
  private latencyAvailable = false;

  public setMemoryRetrievalSuccess(val: boolean | undefined): void {
    this.memoryRetrievalSuccess = val;
  }

  public setConversationRetrievalSuccess(val: boolean | undefined): void {
    this.conversationRetrievalSuccess = val;
  }

  public setMemoryCacheHit(val: boolean | undefined): void {
    this.memoryCacheHit = val;
  }

  public setConversationCacheHit(val: boolean | undefined): void {
    this.conversationCacheHit = val;
  }

  public setMemoryFallbackUsed(val: boolean | undefined): void {
    this.memoryFallbackUsed = val;
  }

  public setConversationFallbackUsed(val: boolean | undefined): void {
    this.conversationFallbackUsed = val;
  }

  public setRetryOccurred(val: boolean): void {
    this.retryOccurred = val;
  }

  public setTimeoutOccurred(val: boolean): void {
    this.timeoutOccurred = val;
  }

  public setLatencyAvailable(val: boolean): void {
    this.latencyAvailable = val;
  }

  public getSummary(): HealthSummary {
    return {
      memoryRetrievalSuccess: this.memoryRetrievalSuccess,
      conversationRetrievalSuccess: this.conversationRetrievalSuccess,
      memoryCacheHit: this.memoryCacheHit,
      conversationCacheHit: this.conversationCacheHit,
      memoryFallbackUsed: this.memoryFallbackUsed,
      conversationFallbackUsed: this.conversationFallbackUsed,
      retryOccurred: this.retryOccurred,
      timeoutOccurred: this.timeoutOccurred,
      latencyAvailable: this.latencyAvailable,
    };
  }
}
