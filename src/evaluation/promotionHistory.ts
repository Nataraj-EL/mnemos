import { PromotionHistoryRecord, TuningConfig } from './types';

export class PromotionHistoryManager {
  private static history: PromotionHistoryRecord[] = [];

  private static deepClone<T>(obj: T): T {
    if (obj === null || obj === undefined) return obj;
    return JSON.parse(JSON.stringify(obj));
  }

  private static sanitizeConfig(config: TuningConfig | null): TuningConfig | null {
    if (!config) return null;
    const cloned = this.deepClone(config);
    const keysToStrip = ['diagnostics', 'prompts', 'sql', 'uuid', 'apiKey', 'provider'];
    for (const key of keysToStrip) {
      if (key in cloned) {
        delete (cloned as unknown as Record<string, unknown>)[key];
      }
    }
    return cloned;
  }

  public static addRecord(
    action: 'promote' | 'rollback',
    previousConfig: TuningConfig | null,
    newConfig: TuningConfig | null
  ): PromotionHistoryRecord {
    const id = `aud-${Math.random().toString(36).substring(2, 11)}`;
    const timestamp = new Date().toISOString();

    const record: PromotionHistoryRecord = {
      id,
      timestamp,
      action,
      previousConfig: this.sanitizeConfig(previousConfig),
      newConfig: this.sanitizeConfig(newConfig),
    };

    this.history.unshift(record);
    if (this.history.length > 20) {
      this.history.pop();
    }

    return this.deepClone(record);
  }

  public static listRecords(): PromotionHistoryRecord[] {
    return this.deepClone(this.history);
  }

  public static clearHistory(): void {
    this.history = [];
  }

  public static getRecord(id: string): PromotionHistoryRecord | null {
    const record = this.history.find((r) => r.id === id);
    if (!record) return null;
    return this.deepClone(record);
  }
}
