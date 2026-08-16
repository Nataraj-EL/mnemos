import { TuningConfig } from './types';
import { EvaluationExperimentRunner } from './experiment';

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
    EvaluationExperimentRunner.validateConfig(config);

    this.previousConfig = this.currentConfig ? JSON.parse(JSON.stringify(this.currentConfig)) : null;
    this.currentConfig = JSON.parse(JSON.stringify(config));
  }

  public static rollback(): void {
    if (!this.previousConfig) {
      return;
    }
    this.currentConfig = this.previousConfig;
    this.previousConfig = null;
  }

  public static hasPromotedConfig(): boolean {
    return this.currentConfig !== null;
  }

  public static clearPromotion(): void {
    this.currentConfig = null;
    this.previousConfig = null;
  }
}
