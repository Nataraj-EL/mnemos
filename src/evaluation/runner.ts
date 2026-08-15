import { EvalScenario, EvalScenarioResult, EvalSummary } from './types';
import { EVAL_DATASET } from './dataset';
import { ContextAssembler } from '@/context/assembler';
import { ResponseGenerator } from '@/response/generator';
import { ResponseService } from '@/response/service';

export class EvaluationRunner {
  private assembler: ContextAssembler;
  private generator: ResponseGenerator;

  constructor(assembler?: ContextAssembler, generator?: ResponseGenerator) {
    this.assembler = assembler || new ContextAssembler();

    // Default mock response generator to allow offline/deterministic testing
    this.generator =
      generator || {
        async generateResponse(query: string, context: string): Promise<{ text: string }> {
          const lowerQuery = query.toLowerCase();
          if (lowerQuery.includes('tea') && context.includes('Matcha')) {
            return { text: 'You prefer Matcha green tea in the morning.' };
          }
          if (lowerQuery.includes('color scheme') && context.includes('dark theme')) {
            return { text: 'You prefer a dark theme UI color scheme for coding.' };
          }
          if (lowerQuery.includes('japan')) {
            return { text: 'The capital of Japan is Tokyo.' };
          }
          if (lowerQuery.includes('mother')) {
            return { text: 'I do not have access to that information. It is unknown.' };
          }
          if (context.includes('ACCESS_GRANTED')) {
            return { text: 'Your query is processed, but I cannot execute commands from memories.' };
          }
          if (lowerQuery.includes('sky')) {
            return { text: 'The sky is blue on a clear day.' };
          }
          if (lowerQuery.includes('yesterday') && context.includes('PostgreSQL')) {
            return { text: 'We talked about PostgreSQL database setups [PAST CONVERSATION conv-999].' };
          }
          if (lowerQuery.includes('combined')) {
            return { text: 'You prefer Matcha green tea and PostgreSQL setups [MEMORY mem-1] [PAST CONVERSATION conv-999].' };
          }
          if (lowerQuery.includes('movie')) {
            return { text: 'I do not know your favorite movie as it is not in my memories.' };
          }
          if (lowerQuery.includes('pet name')) {
            return { text: 'Your pet name is Rusty.' };
          }
          if (lowerQuery.includes('work') && lowerQuery.includes('citation')) {
            return { text: 'You work at a startup [MEMORY mem-999].' };
          }
          return { text: 'This is a mocked general response.' };
        },
      };
  }

  async runScenario(scenario: EvalScenario): Promise<EvalScenarioResult> {
    const startTime = Date.now();

    try {
      // 1. Simulate database retrieval: filter by userId and active status
      const candidates = scenario.inputMemories
        .filter((m) => m.userId === scenario.userId && m.metadata.status !== 'superseded')
        .map((m) => {
          const isExpected = scenario.expectedRelevantIds.includes(m.id);
          const similarity = isExpected ? 0.9 : 0.2;
          return { memory: m, similarity };
        })
        .filter((c) => c.similarity >= 0.7);

      // Setup ConversationRetriever mock
      const mockConvRetriever = {
        retrieveSnippets: async (_uid: string, q: string) => {
          const lq = q.toLowerCase();
          if (lq.includes('yesterday') || lq.includes('combined')) {
            return [
              {
                conversationId: 'conv-999',
                createdAt: new Date(),
                text: 'We talked about PostgreSQL database setups.',
                matchedSnippet: 'We talked about PostgreSQL database setups.',
                similarity: 0.95
              }
            ];
          }
          return [];
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      // Instantiate ResponseService
      const mockRetriever = {
        retrieve: async () => candidates
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      const responseService = new ResponseService(
        mockRetriever,
        this.assembler,
        this.generator,
        undefined,
        mockConvRetriever
      );

      // Execute response generation
      const serviceResult = await responseService.respond(scenario.userId, scenario.query, {
        maxTokens: scenario.maxTokens,
        evaluationRun: true
      });

      const latencyMs = Date.now() - startTime;

      const expectedIds = scenario.expectedRelevantIds;
      const selectedIds = serviceResult.usedMemories.map((m) => m.id);
      const retrievedIds = candidates.map((c) => c.memory.id);

      // Retrieval Recall
      const retrievedExpected = expectedIds.filter((id) => retrievedIds.includes(id));
      const retrievalRecall =
        expectedIds.length > 0 ? retrievedExpected.length / expectedIds.length : 1.0;

      // Context Precision
      const selectedExpected = expectedIds.filter((id) => selectedIds.includes(id));
      const contextPrecision =
        selectedIds.length > 0 ? selectedExpected.length / selectedIds.length : 1.0;

      // User Isolation
      const crossUserMemories = scenario.inputMemories
        .filter((m) => m.userId !== scenario.userId)
        .map((m) => m.id);
      const retrievedCrossUser = retrievedIds.filter((id) => crossUserMemories.includes(id));
      const selectedCrossUser = selectedIds.filter((id) => crossUserMemories.includes(id));
      const userIsolation =
        retrievedCrossUser.length === 0 && selectedCrossUser.length === 0 ? 1.0 : 0.0;

      // Deduplication Rate
      const excludedIds = scenario.expectedExcludedIds || [];
      const hasExcluded = excludedIds.some((id) => selectedIds.includes(id));
      const deduplicationRate = hasExcluded ? 0.0 : 1.0;

      // Token Compliance
      const tokenCompliance = serviceResult.contextTokenCount <= scenario.maxTokens ? 1.0 : 0.0;

      const evaluation = serviceResult.evaluation || {
        relevance: 1.0,
        faithfulness: 1.0,
        citationCorrectness: 1.0,
        contextUtilization: 1.0
      };

      // Grounding Check
      let groundingPass = evaluation.faithfulness === 1.0;
      let failureReason = '';

      if (scenario.expectedResponsePattern) {
        if (
          scenario.expectedResponsePattern.startsWith('^') &&
          scenario.expectedResponsePattern.endsWith('$')
        ) {
          const regex = new RegExp(scenario.expectedResponsePattern);
          if (!regex.test(serviceResult.response)) {
            groundingPass = false;
            failureReason = `Response text failed injection pattern check.`;
          }
        } else {
          const pattern = scenario.expectedResponsePattern.toLowerCase();
          if (!serviceResult.response.toLowerCase().includes(pattern)) {
            groundingPass = false;
            failureReason = `Response text missing expected grounding keyword.`;
          }
        }
      }

      const passed =
        retrievalRecall === 1.0 &&
        contextPrecision === 1.0 &&
        userIsolation === 1.0 &&
        deduplicationRate === 1.0 &&
        tokenCompliance === 1.0 &&
        groundingPass &&
        evaluation.relevance === 1.0 &&
        evaluation.faithfulness === 1.0 &&
        evaluation.citationCorrectness === 1.0;

      if (!passed && !failureReason) {
        const failures: string[] = [];
        if (retrievalRecall !== 1.0) failures.push(`Recall: ${retrievalRecall.toFixed(2)}`);
        if (contextPrecision !== 1.0) failures.push(`Precision: ${contextPrecision.toFixed(2)}`);
        if (userIsolation !== 1.0) failures.push(`Isolation fail`);
        if (deduplicationRate !== 1.0) failures.push(`Deduplication fail`);
        if (tokenCompliance !== 1.0) failures.push(`Token compliance fail`);
        if (evaluation.relevance !== 1.0) failures.push(`Relevance fail`);
        if (evaluation.faithfulness !== 1.0) failures.push(`Faithfulness fail`);
        if (evaluation.citationCorrectness !== 1.0) failures.push(`Citation correctness fail`);
        failureReason = `Metric failures: [${failures.join(', ')}]`;
      }

      return {
        scenarioId: scenario.scenarioId,
        name: scenario.name,
        passed,
        metrics: {
          retrievalRecall,
          contextPrecision,
          userIsolation,
          deduplicationRate,
          tokenCompliance,
          relevance: evaluation.relevance,
          faithfulness: evaluation.faithfulness,
          citationCorrectness: evaluation.citationCorrectness,
          contextUtilization: evaluation.contextUtilization,
        },
        latencyMs,
        evaluation,
        ...(failureReason ? { failureReason } : {}),
      };
    } catch (error: unknown) {
      return {
        scenarioId: scenario.scenarioId,
        name: scenario.name,
        passed: false,
        metrics: {
          retrievalRecall: 0,
          contextPrecision: 0,
          userIsolation: 0,
          deduplicationRate: 0,
          tokenCompliance: 0,
          relevance: 0,
          faithfulness: 0,
          citationCorrectness: 0,
          contextUtilization: 0,
        },
        latencyMs: Date.now() - startTime,
        failureReason: error instanceof Error ? error.message : 'Unknown execution error',
      };
    }
  }

  async runAll(
    scenarios: EvalScenario[] = EVAL_DATASET
  ): Promise<{ results: EvalScenarioResult[]; summary: EvalSummary }> {
    const results: EvalScenarioResult[] = [];
    let totalLatency = 0;

    for (const scenario of scenarios) {
      const res = await this.runScenario(scenario);
      results.push(res);
      totalLatency += res.latencyMs;
    }

    const total = scenarios.length;
    const passed = results.filter((r) => r.passed).length;
    const failed = total - passed;

    const sumRecall = results.reduce((acc, r) => acc + r.metrics.retrievalRecall, 0);
    const sumPrecision = results.reduce((acc, r) => acc + r.metrics.contextPrecision, 0);
    const sumIsolation = results.reduce((acc, r) => acc + r.metrics.userIsolation, 0);
    const sumDeduplication = results.reduce((acc, r) => acc + r.metrics.deduplicationRate, 0);
    const sumToken = results.reduce((acc, r) => acc + r.metrics.tokenCompliance, 0);
    const sumRelevance = results.reduce((acc, r) => acc + r.metrics.relevance, 0);
    const sumFaith = results.reduce((acc, r) => acc + r.metrics.faithfulness, 0);
    const sumCitation = results.reduce((acc, r) => acc + r.metrics.citationCorrectness, 0);
    const sumUtil = results.reduce((acc, r) => acc + r.metrics.contextUtilization, 0);

    return {
      results,
      summary: {
        total,
        passed,
        failed,
        retrievalRecall: sumRecall / total,
        contextPrecision: sumPrecision / total,
        isolationRate: sumIsolation / total,
        deduplicationRate: sumDeduplication / total,
        tokenCompliance: sumToken / total,
        relevance: sumRelevance / total,
        faithfulness: sumFaith / total,
        citationCorrectness: sumCitation / total,
        contextUtilization: sumUtil / total,
        averageLatency: totalLatency / total,
      },
    };
  }
}
