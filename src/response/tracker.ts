export class PerformanceTracker {
  private startTimes = new Map<string, number>();
  private latencies = new Map<string, number>();

  start(stage: string) {
    this.startTimes.set(stage, Date.now());
  }

  stop(stage: string) {
    const start = this.startTimes.get(stage);
    if (start !== undefined) {
      this.latencies.set(stage, Date.now() - start);
    }
  }

  get(stage: string): number | undefined {
    return this.latencies.get(stage);
  }

  getAll(): Record<string, number> {
    const obj: Record<string, number> = {};
    for (const [k, v] of this.latencies.entries()) {
      obj[k] = v;
    }
    return obj;
  }
}
