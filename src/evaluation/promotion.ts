import { TuningConfig } from './types';
import { PromotionHistoryManager } from './promotionHistory';

import { ConfigSafetyGuard } from './configGuard';

export class EvaluationConfigPromotionManager {
  private static currentConfig: TuningConfig | null = null;
  private static previousConfig: TuningConfig | null = null;

  public static getCurrentConfig(): TuningConfig | null {
    if (!this.currentConfig) return null;
    return JSON.parse(JSON.stringify(this.currentConfig));
  }

  public static getPreviousConfig(): TuningConfig | null {
    if (!this.previousConfig) return null;
    return JSON.parse(JSON.stringify(this.previousConfig));
  }

  public static promote(config: TuningConfig): void {
    const check = ConfigSafetyGuard.validate(config);
    if (!check.valid) {
      throw new Error(`Invalid configuration: ${check.errors.join(', ')}`);
    }

    const oldConfig = this.currentConfig ? JSON.parse(JSON.stringify(this.currentConfig)) : null;
    const newConfig = JSON.parse(JSON.stringify(config));

    this.previousConfig = oldConfig;
    this.currentConfig = newConfig;

    PromotionHistoryManager.addRecord('promote', oldConfig, newConfig);
  }

  public static rollback(): void {
    if (!this.previousConfig) {
      return;
    }
    const oldConfig = this.currentConfig ? JSON.parse(JSON.stringify(this.currentConfig)) : null;
    const newConfig = this.previousConfig ? JSON.parse(JSON.stringify(this.previousConfig)) : null;

    this.currentConfig = this.previousConfig;
    this.previousConfig = null;

    PromotionHistoryManager.addRecord('rollback', oldConfig, newConfig);
  }

  public static hasPromotedConfig(): boolean {
    return this.currentConfig !== null;
  }

  public static clearPromotion(): void {
    this.currentConfig = null;
    this.previousConfig = null;
  }
}
