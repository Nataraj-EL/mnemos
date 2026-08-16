import { TuningConfig, ConfigSafetyResult } from './types';
import { EvaluationExperimentRunner } from './experiment';

export class ConfigSafetyGuard {
  public static validate(config: TuningConfig): ConfigSafetyResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    try {
      EvaluationExperimentRunner.validateConfig(config);
    } catch (err: unknown) {
      if (err instanceof Error) {
        errors.push(err.message.replace('Invalid configuration: ', ''));
      } else {
        errors.push('Unknown base validation error.');
      }
    }

    const weightSum = config.semanticWeight + config.lexicalWeight;
    if (Math.abs(weightSum - 1.0) > 1e-6) {
      errors.push('semanticWeight and lexicalWeight sum must equal 1.0.');
    }

    if (config.semanticWeight > 0.95) {
      warnings.push('semanticWeight exceeds 0.95. Lexical matching is heavily minimized.');
    }
    if (config.lexicalWeight > 0.95) {
      warnings.push('lexicalWeight exceeds 0.95. Semantic matching is heavily minimized.');
    }

    if (config.minSimilarity > 0.9) {
      warnings.push('minSimilarity exceeds 0.9. Extreme threshold may restrict matches and degrade recall.');
    }
    if (config.minSimilarity < 0.1) {
      warnings.push('minSimilarity is below 0.1. Low threshold may retrieve irrelevant candidates and degrade precision.');
    }

    if (config.maxConversationSnippets > 20) {
      warnings.push('maxConversationSnippets exceeds 20. Extreme limits may cause context token exhaustion.');
    }
    if (config.maxConversationSnippets < 2) {
      warnings.push('maxConversationSnippets is below 2. Insufficient conversation history window.');
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }
}
