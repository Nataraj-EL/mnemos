'use client';

import { useEffect, useState } from 'react';

interface MemoryMetadata {
  source: string;
  confidence: number;
  importance: number;
  timestamp: string;
  status?: 'active' | 'superseded';
  [key: string]: unknown;
}

interface Memory {
  id: string;
  userId: string;
  type: string;
  content: string;
  metadata: MemoryMetadata;
  createdAt: string;
  updatedAt: string;
}

interface ContextItem {
  id: string;
  type: string;
  content: string;
  similarity: number;
  importance: number;
  score: number;
  reason: string;
}

interface ContextResult {
  query: string;
  items: ContextItem[];
  context: string;
  tokenCount: number;
}

interface EvalScenarioMetrics {
  retrievalRecall: number;
  contextPrecision: number;
  userIsolation: number;
  deduplicationRate: number;
  tokenCompliance: number;
}

interface EvalScenarioResult {
  scenarioId: string;
  name: string;
  passed: boolean;
  metrics: EvalScenarioMetrics;
  latencyMs: number;
  failureReason?: string;
}

interface EvalSummary {
  total: number;
  passed: number;
  failed: number;
  retrievalRecall: number;
  contextPrecision: number;
  isolationRate: number;
  deduplicationRate: number;
  tokenCompliance: number;
  averageLatency: number;
}

interface HealthResponse {
  status: string;
  timestamp: string;
  services: {
    app: string;
    database: string;
  };
}

export default function Home() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [loadingHealth, setLoadingHealth] = useState(true);
  const [healthError, setHealthError] = useState(false);

  // Ingestion form state
  const [userId, setUserId] = useState('user-123');
  const [contentInput, setContentInput] = useState('');
  const [ingestLoading, setIngestLoading] = useState(false);
  const [ingestMessage, setIngestMessage] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  // Memories list state
  const [memories, setMemories] = useState<Memory[]>([]);
  const [loadingMemories, setLoadingMemories] = useState(true);

  // Search State
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<{ memory: Memory; similarity: number }[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Mount State
  const [mounted, setMounted] = useState(false);

  const handleSearchSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim() || !userId.trim()) return;

    setSearchLoading(true);
    setSearchError(null);

    try {
      const response = await fetch(
        `/api/memory/search?userId=${encodeURIComponent(userId.trim())}&q=${encodeURIComponent(
          searchQuery.trim()
        )}`
      );
      const data = await response.json();

      if (!response.ok) {
        setSearchError(data.error || 'Failed to execute search.');
      } else {
        setSearchResults(data.results || []);
      }
    } catch (err) {
      console.error('Search Error:', err);
      setSearchError('An error occurred during search.');
    } finally {
      setSearchLoading(false);
    }
  };

  // Context Assembly State
  const [contextQuery, setContextQuery] = useState('');
  const [contextLimit, setContextLimit] = useState(10);
  const [contextMaxTokens, setContextMaxTokens] = useState(1500);
  const [contextResult, setContextResult] = useState<ContextResult | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextError, setContextError] = useState<string | null>(null);

  const handleContextSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!contextQuery.trim() || !userId.trim()) return;

    setContextLoading(true);
    setContextError(null);
    setContextResult(null);

    try {
      const response = await fetch('/api/memory/context', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userId: userId.trim(),
          query: contextQuery.trim(),
          limit: Number(contextLimit),
          maxTokens: Number(contextMaxTokens),
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        setContextError(data.error || 'Failed to assemble context.');
      } else {
        setContextResult(data);
      }
    } catch (err) {
      console.error('Context Assembly Error:', err);
      setContextError('An error occurred during context assembly.');
    } finally {
      setContextLoading(false);
    }
  };

  // Contextual Response State
  const [responseQuery, setResponseQuery] = useState('');
  const [responseLimit, setResponseLimit] = useState(10);
  const [responseMaxTokens, setResponseMaxTokens] = useState(1500);
  const [responseResult, setResponseResult] = useState<{
    response: string;
    usedMemories: { id: string; type: string; similarity: number; score: number }[];
    contextTokenCount: number;
  } | null>(null);
  const [responseLoading, setResponseLoading] = useState(false);
  const [responseError, setResponseError] = useState<string | null>(null);

  const handleResponseSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!responseQuery.trim() || !userId.trim()) return;

    setResponseLoading(true);
    setResponseError(null);
    setResponseResult(null);

    try {
      const response = await fetch('/api/memory/respond', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userId: userId.trim(),
          query: responseQuery.trim(),
          limit: Number(responseLimit),
          maxTokens: Number(responseMaxTokens),
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        setResponseError(data.error || 'Failed to generate contextual response.');
      } else {
        setResponseResult(data);
      }
    } catch (err) {
      console.error('Response Generation Error:', err);
      setResponseError('An error occurred during response generation.');
    } finally {
      setResponseLoading(false);
    }
  };

  // Evaluation State
  const [evalSummary, setEvalSummary] = useState<EvalSummary | null>(null);
  const [evalResults, setEvalResults] = useState<EvalScenarioResult[]>([]);
  const [evalLoading, setEvalLoading] = useState(false);
  const [evalError, setEvalError] = useState<string | null>(null);

  const handleRunEvaluation = async () => {
    setEvalLoading(true);
    setEvalError(null);
    setEvalSummary(null);
    setEvalResults([]);

    try {
      const response = await fetch('/api/evaluation/run', { method: 'POST' });
      const data = await response.json();
      if (!response.ok) {
        // Fallback to client-side evaluation if server route is restricted/disabled
        console.warn('Server evaluation endpoint returned error. Running locally in browser...', data.error);
        const { EvaluationRunner } = await import('@/evaluation/runner');
        const runner = new EvaluationRunner();
        const localResult = await runner.runAll();
        setEvalSummary(localResult.summary);
        setEvalResults(localResult.results);
      } else {
        setEvalSummary(data.summary);
        setEvalResults(data.results);
      }
    } catch (err) {
      console.error('Failed to execute evaluation:', err);
      setEvalError('An unexpected error occurred during evaluation.');
    } finally {
      setEvalLoading(false);
    }
  };

  const fetchHealth = async () => {
    try {
      const response = await fetch('/api/health');
      if (!response.ok) {
        setHealthError(true);
      } else {
        setHealthError(false);
      }
      const data = await response.json();
      setHealth(data);
    } catch (err) {
      console.error('Failed to fetch system status:', err);
      setHealthError(true);
      setHealth(null);
    } finally {
      setLoadingHealth(false);
    }
  };

  const fetchMemories = async () => {
    if (!userId.trim()) return;
    try {
      setLoadingMemories(true);
      const response = await fetch(`/api/memory?userId=${encodeURIComponent(userId.trim())}`);
      if (response.ok) {
        const data = await response.json();
        setMemories(data.memories || []);
      }
    } catch (err) {
      console.error('Failed to fetch memories:', err);
    } finally {
      setLoadingMemories(false);
    }
  };

  useEffect(() => {
    setTimeout(() => {
      setMounted(true);
      fetchHealth();
    }, 0);
    // Poll the health check API every 15 seconds
    const healthInterval = setInterval(fetchHealth, 15000);
    return () => clearInterval(healthInterval);
  }, []);

  useEffect(() => {
    setTimeout(() => {
      fetchMemories();
    }, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const handleIngestSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!contentInput.trim() || !userId.trim()) return;

    setIngestLoading(true);
    setIngestMessage(null);

    try {
      const response = await fetch('/api/memory/ingest', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userId: userId.trim(),
          content: contentInput.trim(),
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        setIngestMessage({
          type: 'error',
          text: data.error || 'Failed to ingest memory.',
        });
      } else {
        setIngestMessage({
          type: 'success',
          text: `Successfully processed ingestion pipeline. Reconciled memory changes.`,
        });
        setContentInput('');
        fetchMemories(); // Refresh memories list
      }
    } catch (err) {
      console.error('Ingestion Error:', err);
      setIngestMessage({
        type: 'error',
        text: 'An error occurred during submission.',
      });
    } finally {
      setIngestLoading(false);
    }
  };

  const isDbConnected = health?.services.database === 'connected';
  const isAppHealthy = health?.status === 'healthy';

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* Navigation Bar */}
      <nav className="navbar">
        <div className="brand">
          <div className="brand-logo">Mn</div>
          <div className="brand-text">
            <span className="brand-name">Mnemos</span>
            <span className="brand-tagline">Persistent AI Memory</span>
          </div>
        </div>

        <div className="status-badge" id="system-status-container">
          <span
            className={`status-dot ${
              loadingHealth ? 'warning' : healthError ? 'error' : isAppHealthy ? 'success' : 'error'
            }`}
            id="status-indicator-dot"
          ></span>
          <span id="status-indicator-text">
            {loadingHealth
              ? 'Checking status...'
              : healthError
              ? 'Offline / Error'
              : isAppHealthy
              ? 'Systems Operational'
              : 'Degraded Performance'}
          </span>
        </div>
      </nav>

      {/* Main Content Area */}
      <main className="container" style={{ flexGrow: 1 }}>
        {/* Hero Section */}
        <section className="hero">
          <h1>Mnemos</h1>
          <p>
            Persistent Memory & Context Engine for Personal AI. Establish long-term state, recall,
            and contextual continuity across conversations and session boundaries.
          </p>
          <div className="hero-stats">
            <div className="status-badge">
              <span>Application Status:</span>
              <span className={`status-dot ${isAppHealthy ? 'success' : 'error'}`}></span>
              <strong style={{ marginLeft: '0.25rem' }}>
                {loadingHealth ? 'LOADING' : isAppHealthy ? 'ONLINE' : 'OFFLINE'}
              </strong>
            </div>
            <div className="status-badge">
              <span>Neon Database:</span>
              <span className={`status-dot ${isDbConnected ? 'success' : 'error'}`}></span>
              <strong style={{ marginLeft: '0.25rem' }}>
                {loadingHealth ? 'LOADING' : isDbConnected ? 'CONNECTED' : 'DISCONNECTED'}
              </strong>
            </div>
          </div>
        </section>

        {/* Placeholder Features Grid */}
        <div className="grid">
          {/* Memories Card */}
          <div className="card">
            <h3 className="card-title">🧠 Memory Store</h3>
            <div className="card-content">
              <p>
                A high-reliability persistence layer for memories categorized by specific cognitive forms.
              </p>
              <div style={{ marginTop: '1rem', display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                <span className="badge">Fact</span>
                <span className="badge">Preference</span>
                <span className="badge">Goal</span>
                <span className="badge">Decision</span>
                <span className="badge">Event</span>
                <span className="badge">Relationship</span>
              </div>
            </div>
            <div className="card-footer">
              <span>Storage API Integration</span>
              <span className="badge" style={{ backgroundColor: 'var(--muted)', borderColor: 'var(--border)' }}>
                Sprint 2
              </span>
            </div>
          </div>

          {/* Context Retrieval Card */}
          <div className="card">
            <h3 className="card-title">🎯 Context Resolver</h3>
            <div className="card-content">
              <p>
                Dynamic window generation to inject relevant memories back into active agent prompts based on query triggers.
              </p>
              <p style={{ marginTop: '0.5rem', fontStyle: 'italic', fontSize: '0.85rem', opacity: 0.7 }}>
                Calculates relevancy indexes, filtering out stale facts.
              </p>
            </div>
            <div className="card-footer">
              <span>Semantic & Temporal Search</span>
              <span className="badge" style={{ backgroundColor: 'var(--muted)', borderColor: 'var(--border)' }}>
                Sprint 3
              </span>
            </div>
          </div>

          {/* Evaluation Card */}
          <div className="card">
            <h3 className="card-title">⚡ Performance & Evaluation</h3>
            <div className="card-content">
              <p>
                Track indexing latency, memory retrieval precision, recall metrics, and system operations logs.
              </p>
              <p style={{ marginTop: '0.5rem', fontStyle: 'italic', fontSize: '0.85rem', opacity: 0.7 }}>
                Ensures predictable context synthesis.
              </p>
            </div>
            <div className="card-footer">
              <span>Observability Console</span>
              <span className="badge" style={{ backgroundColor: 'var(--muted)', borderColor: 'var(--border)' }}>
                Sprint 2
              </span>
            </div>
          </div>
        </div>

        {/* Ingestion & Memories Split Layout */}
        <section style={{ marginTop: '3rem', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '2rem' }}>
          {/* Ingestion Form Card */}
          <div className="card">
            <h3 className="card-title">📥 Ingest Raw Interaction</h3>
            <form onSubmit={handleIngestSubmit} style={{ marginTop: '1rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.25rem' }}>User ID</label>
                <input
                  type="text"
                  value={userId}
                  onChange={(e) => setUserId(e.target.value)}
                  style={{ width: '100%', padding: '0.5rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text)' }}
                  required
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.25rem' }}>Raw Interaction Statement</label>
                <textarea
                  rows={5}
                  value={contentInput}
                  onChange={(e) => setContentInput(e.target.value)}
                  placeholder="e.g. I prefer serverless postgres architecture and have decided to use Neon PostgreSQL."
                  style={{ width: '100%', padding: '0.5rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text)', resize: 'vertical', fontFamily: 'inherit' }}
                  required
                />
              </div>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={!mounted || ingestLoading || !contentInput.trim()}
              >
                {ingestLoading ? 'Processing Ingestion...' : 'Submit to Engine'}
              </button>

              {ingestMessage && (
                <div style={{
                  padding: '0.75rem',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: '0.85rem',
                  border: '1px solid',
                  borderColor: ingestMessage.type === 'success' ? 'var(--success)' : 'var(--error)',
                  backgroundColor: ingestMessage.type === 'success' ? 'rgba(91, 138, 82, 0.1)' : 'rgba(179, 74, 60, 0.1)',
                  color: ingestMessage.type === 'success' ? 'var(--success)' : 'var(--error)'
                }}>
                  {ingestMessage.text}
                </div>
              )}
            </form>
          </div>

          {/* Memories List Card */}
          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h3 className="card-title" style={{ marginBottom: 0 }}>🗃️ Persisted Memories</h3>
              <span className="badge" style={{ fontSize: '0.85rem' }}>Count: {memories.length}</span>
            </div>

            {loadingMemories && memories.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '2rem', opacity: 0.6 }}>Loading memories...</div>
            ) : memories.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '3rem', opacity: 0.6, border: '1px dashed var(--border)', borderRadius: 'var(--radius-md)' }}>
                No memories persisted yet for user <strong>{userId}</strong>.
                Use the Ingestion panel on the left to extract and persist memories.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxHeight: '450px', overflowY: 'auto', paddingRight: '0.25rem' }}>
                {memories.map((memory) => (
                  <div key={memory.id} style={{
                    padding: '1rem',
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--border)',
                    backgroundColor: memory.metadata.status === 'superseded' ? 'var(--muted)' : 'var(--surface)',
                    opacity: memory.metadata.status === 'superseded' ? 0.65 : 1,
                    transition: 'opacity 0.2s'
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                      <span className="badge" style={{ backgroundColor: 'var(--background)', color: 'var(--primary)', fontWeight: 'bold' }}>
                        {memory.type}
                      </span>
                      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                        <span style={{ fontSize: '0.75rem', opacity: 0.8 }}>
                          Conf: <strong>{(memory.metadata.confidence * 100).toFixed(0)}%</strong>
                        </span>
                        <span style={{ fontSize: '0.75rem', opacity: 0.8 }}>
                          Imp: <strong>{memory.metadata.importance}/10</strong>
                        </span>
                        {memory.metadata.status === 'superseded' && (
                          <span className="badge" style={{ backgroundColor: 'var(--error)', color: '#fff', fontSize: '0.7rem' }}>
                            SUPERSEDED
                          </span>
                        )}
                      </div>
                    </div>
                    <p style={{ fontWeight: 500, fontSize: '0.95rem' }}>{memory.content}</p>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', opacity: 0.5, marginTop: '0.5rem', borderTop: '1px solid var(--border)', paddingTop: '0.5rem' }}>
                      <span>Source: {memory.metadata.source}</span>
                      <span>Observed: {new Date(memory.metadata.timestamp || memory.createdAt).toLocaleDateString()}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* Semantic Search Panel */}
        <section className="card" style={{ marginTop: '2.5rem' }}>
          <h3 className="card-title">🔍 Semantic Memory Search</h3>
          <p style={{ fontSize: '0.9rem', opacity: 0.7, marginBottom: '1.25rem' }}>
            Query active memories using cosine similarity matching. Enter a concept or preference description.
          </p>

          <form onSubmit={handleSearchSubmit} style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', marginBottom: '1.25rem' }}>
            <input
              type="text"
              placeholder="e.g. databases, coding preferences, goals..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{
                flexGrow: 1,
                minWidth: '280px',
                padding: '0.5rem 1rem',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--border)',
                backgroundColor: 'var(--surface)',
                color: 'var(--text)'
              }}
              required
            />
            <button
              type="submit"
              className="btn btn-primary"
              disabled={!mounted || searchLoading || !searchQuery.trim()}
            >
              {searchLoading ? 'Searching...' : 'Search Context'}
            </button>
          </form>

          {searchError && (
            <div style={{
              padding: '0.75rem',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--error)',
              backgroundColor: 'rgba(179, 74, 60, 0.1)',
              color: 'var(--error)',
              marginBottom: '1.25rem',
              fontSize: '0.85rem'
            }}>
              {searchError}
            </div>
          )}

          {searchLoading ? (
            <div style={{ textAlign: 'center', padding: '2rem', opacity: 0.6 }}>Executing semantic vector search...</div>
          ) : searchResults.length === 0 ? (
            searchQuery && (
              <div style={{ textAlign: 'center', padding: '2rem', opacity: 0.6, border: '1px dashed var(--border)', borderRadius: 'var(--radius-md)' }}>
                No active memories found matching &quot;<strong>{searchQuery}</strong>&quot;.
              </div>
            )
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {searchResults.map((result) => {
                const { memory, similarity } = result;
                const scorePercent = (similarity * 100).toFixed(1);
                return (
                  <div key={memory.id} style={{
                    padding: '1rem',
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--border)',
                    backgroundColor: 'var(--surface)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.5rem',
                    position: 'relative'
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span className="badge" style={{ backgroundColor: 'var(--background)', color: 'var(--primary)', fontWeight: 'bold' }}>
                        {memory.type}
                      </span>
                      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginLeft: 'auto' }}>
                        <span style={{ fontSize: '0.85rem', color: 'var(--primary)', fontWeight: 'bold' }}>
                          Similarity: {scorePercent}%
                        </span>
                        <span style={{ fontSize: '0.75rem', opacity: 0.65 }}>
                          Conf: {(memory.metadata.confidence * 100).toFixed(0)}%
                        </span>
                        <span style={{ fontSize: '0.75rem', opacity: 0.65 }}>
                          Imp: {memory.metadata.importance}/10
                        </span>
                      </div>
                    </div>
                    <p style={{ fontWeight: 500, fontSize: '1rem', marginTop: '0.25rem' }}>{memory.content}</p>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', opacity: 0.5, borderTop: '1px solid var(--border)', paddingTop: '0.5rem', marginTop: '0.25rem' }}>
                      <span>Source: {memory.metadata.source}</span>
                      <span>Observed: {new Date(memory.metadata.timestamp || memory.createdAt).toLocaleString()}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Context Preview Panel */}
        <section className="card" style={{ marginTop: '2.5rem' }}>
          <h3 className="card-title">🧩 Context Assembly Preview</h3>
          <p style={{ fontSize: '0.9rem', opacity: 0.7, marginBottom: '1.25rem' }}>
            Deterministically filter, score, deduplicate, and token-budget your memories to synthesize structured context templates.
          </p>

          <form onSubmit={handleContextSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginBottom: '1.5rem' }}>
            <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
              <div style={{ flexGrow: 1, minWidth: '280px' }}>
                <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.25rem' }}>Contextual Query / Topic</label>
                <input
                  type="text"
                  placeholder="e.g. database choices or language preferences..."
                  value={contextQuery}
                  onChange={(e) => setContextQuery(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '0.5rem 1rem',
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--border)',
                    backgroundColor: 'var(--surface)',
                    color: 'var(--text)'
                  }}
                  required
                />
              </div>
              <div style={{ width: '120px' }}>
                <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.25rem' }}>Limit</label>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={contextLimit}
                  onChange={(e) => setContextLimit(Number(e.target.value))}
                  style={{
                    width: '100%',
                    padding: '0.5rem',
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--border)',
                    backgroundColor: 'var(--surface)',
                    color: 'var(--text)'
                  }}
                  required
                />
              </div>
              <div style={{ width: '140px' }}>
                <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.25rem' }}>Max Tokens</label>
                <input
                  type="number"
                  min={1}
                  value={contextMaxTokens}
                  onChange={(e) => setContextMaxTokens(Number(e.target.value))}
                  style={{
                    width: '100%',
                    padding: '0.5rem',
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--border)',
                    backgroundColor: 'var(--surface)',
                    color: 'var(--text)'
                  }}
                  required
                />
              </div>
            </div>
            
            <button
              type="submit"
              className="btn btn-primary"
              style={{ alignSelf: 'flex-start' }}
              disabled={!mounted || contextLoading || !contextQuery.trim()}
            >
              {contextLoading ? 'Assembling Context...' : 'Assemble Prompt Context'}
            </button>
          </form>

          {contextError && (
            <div style={{
              padding: '0.75rem',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--error)',
              backgroundColor: 'rgba(179, 74, 60, 0.1)',
              color: 'var(--error)',
              marginBottom: '1.25rem',
              fontSize: '0.85rem'
            }}>
              {contextError}
            </div>
          )}

          {contextLoading ? (
            <div style={{ textAlign: 'center', padding: '2rem', opacity: 0.6 }}>Running context selection heuristics...</div>
          ) : contextResult && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', marginTop: '1rem', borderTop: '1px solid var(--border)', paddingTop: '1.5rem' }}>
              
              {/* Selected memories and reasons */}
              <div>
                <h4 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.75rem', display: 'flex', justifyContent: 'space-between' }}>
                  <span>📋 Selected Memory Items</span>
                  <span style={{ fontSize: '0.85rem', opacity: 0.7 }}>Selected: {contextResult.items.length}</span>
                </h4>
                
                {contextResult.items.length === 0 ? (
                  <div style={{ padding: '1.5rem', textAlign: 'center', opacity: 0.6, border: '1px dashed var(--border)', borderRadius: 'var(--radius-sm)' }}>
                    No memories were selected. Either the search returned no results, or the first memory exceeded your token budget.
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                    {contextResult.items.map((item) => (
                      <div key={item.id} style={{
                        padding: '0.75rem 1rem',
                        borderRadius: 'var(--radius-sm)',
                        border: '1px solid var(--border)',
                        backgroundColor: 'var(--surface)'
                      }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.25rem' }}>
                          <span className="badge" style={{ backgroundColor: 'var(--background)', color: 'var(--primary)', fontWeight: 'bold', fontSize: '0.75rem' }}>
                            {item.type}
                          </span>
                          <span style={{ fontSize: '0.8rem', opacity: 0.6, fontStyle: 'italic' }}>
                            ID: {item.id.substring(0, 8)}...
                          </span>
                        </div>
                        <p style={{ fontWeight: 500, fontSize: '0.95rem', margin: '0.25rem 0' }}>{item.content}</p>
                        <div style={{ fontSize: '0.75rem', color: 'var(--primary)', opacity: 0.85, marginTop: '0.5rem', borderTop: '1px dotted var(--border)', paddingTop: '0.25rem' }}>
                          ℹ️ {item.reason}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Complete assembled context block */}
              <div>
                <h4 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.75rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>📄 Compiled Prompt Context Block</span>
                  <span className="badge" style={{ backgroundColor: 'var(--primary)', color: '#fff', fontSize: '0.8rem' }}>
                    Estimated Tokens: {contextResult.tokenCount}
                  </span>
                </h4>
                <pre style={{
                  padding: '1rem',
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--border)',
                  backgroundColor: 'var(--background)',
                  color: 'var(--text)',
                  fontFamily: 'monospace',
                  fontSize: '0.9rem',
                  whiteSpace: 'pre-wrap',
                  maxHeight: '300px',
                  overflowY: 'auto'
                }}>
                  {contextResult.context || '/* Empty Context Block */'}
                </pre>
              </div>

            </div>
          )}
        </section>

        {/* Contextual Response Panel */}
        <section className="card" style={{ marginTop: '2.5rem' }}>
          <h3 className="card-title">💬 Contextual Response Engine</h3>
          <p style={{ fontSize: '0.9rem', opacity: 0.7, marginBottom: '1.25rem' }}>
            Query your persistent memory repository. The system will retrieve matching records, score/deduplicate them under a token budget, and ground the LLM generation using the assembled context.
          </p>

          <form onSubmit={handleResponseSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginBottom: '1.5rem' }}>
            <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
              <div style={{ flexGrow: 1, minWidth: '280px' }}>
                <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.25rem' }}>Your Question</label>
                <input
                  type="text"
                  placeholder="e.g. What is my favorite hot drink? or What do you know about me?"
                  value={responseQuery}
                  onChange={(e) => setResponseQuery(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '0.5rem 1rem',
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--border)',
                    backgroundColor: 'var(--surface)',
                    color: 'var(--text)'
                  }}
                  required
                />
              </div>
              <div style={{ width: '120px' }}>
                <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.25rem' }}>Limit</label>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={responseLimit}
                  onChange={(e) => setResponseLimit(Number(e.target.value))}
                  style={{
                    width: '100%',
                    padding: '0.5rem',
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--border)',
                    backgroundColor: 'var(--surface)',
                    color: 'var(--text)'
                  }}
                  required
                />
              </div>
              <div style={{ width: '140px' }}>
                <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.25rem' }}>Max Tokens</label>
                <input
                  type="number"
                  min={1}
                  value={responseMaxTokens}
                  onChange={(e) => setResponseMaxTokens(Number(e.target.value))}
                  style={{
                    width: '100%',
                    padding: '0.5rem',
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--border)',
                    backgroundColor: 'var(--surface)',
                    color: 'var(--text)'
                  }}
                  required
                />
              </div>
            </div>
            
            <button
              type="submit"
              className="btn btn-primary"
              style={{ alignSelf: 'flex-start' }}
              disabled={!mounted || responseLoading || !responseQuery.trim()}
            >
              {responseLoading ? 'Generating Response...' : 'Generate Grounded Response'}
            </button>
          </form>

          {responseError && (
            <div style={{
              padding: '0.75rem',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--error)',
              backgroundColor: 'rgba(179, 74, 60, 0.1)',
              color: 'var(--error)',
              marginBottom: '1.25rem',
              fontSize: '0.85rem'
            }}>
              {responseError}
            </div>
          )}

          {responseLoading ? (
            <div style={{ textAlign: 'center', padding: '2rem', opacity: 0.6 }}>Running contextual synthesis pipeline...</div>
          ) : responseResult && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', marginTop: '1rem', borderTop: '1px solid var(--border)', paddingTop: '1.5rem' }}>
              
              {/* Generated text response */}
              <div>
                <h4 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.75rem' }}>🤖 Grounded AI Response</h4>
                <div style={{
                  padding: '1.25rem',
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--border)',
                  backgroundColor: 'var(--background)',
                  color: 'var(--text)',
                  lineHeight: '1.6',
                  fontSize: '1rem',
                  whiteSpace: 'pre-wrap'
                }}>
                  {responseResult.response}
                </div>
              </div>

              {/* Supporting context trace metadata */}
              <div>
                <h4 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.75rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>🔒 Supporting Memories Trace (Grounded Context)</span>
                  <span className="badge" style={{ backgroundColor: 'var(--primary)', color: '#fff', fontSize: '0.8rem' }}>
                    Context Tokens: {responseResult.contextTokenCount}
                  </span>
                </h4>

                {responseResult.usedMemories.length === 0 ? (
                  <div style={{ padding: '1rem', textAlign: 'center', opacity: 0.6, border: '1px dashed var(--border)', borderRadius: 'var(--radius-sm)', fontSize: '0.9rem' }}>
                    No memories were passed to the LLM (zero relevant context matching this query).
                  </div>
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '0.75rem' }}>
                    {responseResult.usedMemories.map((used) => (
                      <div key={used.id} style={{
                        padding: '0.75rem 1rem',
                        borderRadius: 'var(--radius-sm)',
                        border: '1px solid var(--border)',
                        backgroundColor: 'var(--surface)'
                      }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.25rem' }}>
                          <span className="badge" style={{ backgroundColor: 'var(--background)', color: 'var(--primary)', fontWeight: 'bold', fontSize: '0.75rem' }}>
                            {used.type}
                          </span>
                          <span style={{ fontSize: '0.8rem', opacity: 0.6 }}>
                            ID: {used.id.substring(0, 8)}...
                          </span>
                        </div>
                        <div style={{ fontSize: '0.8rem', opacity: 0.7, marginTop: '0.5rem', display: 'flex', gap: '1rem' }}>
                          <span>Similarity: <strong>{used.similarity.toFixed(2)}</strong></span>
                          <span>Score: <strong>{used.score.toFixed(3)}</strong></span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

            </div>
          )}
        </section>

        {/* Evaluation & Observability Panel */}
        <section className="card" style={{ marginTop: '2.5rem' }}>
          <h3 className="card-title">📊 Evaluation & Observability</h3>
          <p style={{ fontSize: '0.9rem', opacity: 0.7, marginBottom: '1.25rem' }}>
            Run the 16-scenario synthetic benchmark suite to evaluate memory recall, user isolation boundaries, Jaccard/containment deduplication rates, and token compliance.
          </p>

          <button
            onClick={handleRunEvaluation}
            className="btn btn-primary"
            style={{ marginBottom: '1.5rem' }}
            disabled={evalLoading}
          >
            {evalLoading ? 'Running Benchmarks...' : 'Run Benchmark Evaluation'}
          </button>

          {evalError && (
            <div style={{
              padding: '0.75rem',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--error)',
              backgroundColor: 'rgba(179, 74, 60, 0.1)',
              color: 'var(--error)',
              marginBottom: '1.25rem',
              fontSize: '0.85rem'
            }}>
              {evalError}
            </div>
          )}

          {evalLoading ? (
            <div style={{ textAlign: 'center', padding: '2rem', opacity: 0.6 }}>Executing benchmark scenarios...</div>
          ) : evalSummary && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
              
              {/* Summary Stats Grid */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '1rem' }}>
                <div style={{ padding: '0.75rem 1rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', backgroundColor: 'var(--surface)', textAlign: 'center' }}>
                  <div style={{ fontSize: '0.8rem', opacity: 0.6, textTransform: 'uppercase', fontWeight: 600 }}>Total Scenarios</div>
                  <div style={{ fontSize: '1.75rem', fontWeight: 'bold', color: 'var(--text)' }}>{evalSummary.total}</div>
                </div>
                <div style={{ padding: '0.75rem 1rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', backgroundColor: 'rgba(74, 117, 89, 0.1)', borderLeft: '4px solid var(--success)', textAlign: 'center' }}>
                  <div style={{ fontSize: '0.8rem', color: 'var(--success)', textTransform: 'uppercase', fontWeight: 600 }}>Passed</div>
                  <div style={{ fontSize: '1.75rem', fontWeight: 'bold', color: 'var(--success)' }}>{evalSummary.passed}</div>
                </div>
                <div style={{ padding: '0.75rem 1rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', backgroundColor: 'rgba(179, 74, 60, 0.1)', borderLeft: '4px solid var(--error)', textAlign: 'center' }}>
                  <div style={{ fontSize: '0.8rem', color: 'var(--error)', textTransform: 'uppercase', fontWeight: 600 }}>Failed</div>
                  <div style={{ fontSize: '1.75rem', fontWeight: 'bold', color: 'var(--error)' }}>{evalSummary.failed}</div>
                </div>
                <div style={{ padding: '0.75rem 1rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', backgroundColor: 'var(--surface)', textAlign: 'center' }}>
                  <div style={{ fontSize: '0.8rem', opacity: 0.6, textTransform: 'uppercase', fontWeight: 600 }}>Recall Rate</div>
                  <div style={{ fontSize: '1.75rem', fontWeight: 'bold', color: 'var(--text)' }}>{(evalSummary.retrievalRecall * 100).toFixed(0)}%</div>
                </div>
                <div style={{ padding: '0.75rem 1rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', backgroundColor: 'var(--surface)', textAlign: 'center' }}>
                  <div style={{ fontSize: '0.8rem', opacity: 0.6, textTransform: 'uppercase', fontWeight: 600 }}>Precision</div>
                  <div style={{ fontSize: '1.75rem', fontWeight: 'bold', color: 'var(--text)' }}>{(evalSummary.contextPrecision * 100).toFixed(0)}%</div>
                </div>
                <div style={{ padding: '0.75rem 1rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', backgroundColor: 'var(--surface)', textAlign: 'center' }}>
                  <div style={{ fontSize: '0.8rem', opacity: 0.6, textTransform: 'uppercase', fontWeight: 600 }}>Isolation</div>
                  <div style={{ fontSize: '1.75rem', fontWeight: 'bold', color: 'var(--success)' }}>{(evalSummary.isolationRate * 100).toFixed(0)}%</div>
                </div>
                <div style={{ padding: '0.75rem 1rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', backgroundColor: 'var(--surface)', textAlign: 'center' }}>
                  <div style={{ fontSize: '0.8rem', opacity: 0.6, textTransform: 'uppercase', fontWeight: 600 }}>Deduplication</div>
                  <div style={{ fontSize: '1.75rem', fontWeight: 'bold', color: 'var(--text)' }}>{(evalSummary.deduplicationRate * 100).toFixed(0)}%</div>
                </div>
                <div style={{ padding: '0.75rem 1rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', backgroundColor: 'var(--surface)', textAlign: 'center' }}>
                  <div style={{ fontSize: '0.8rem', opacity: 0.6, textTransform: 'uppercase', fontWeight: 600 }}>Avg Latency</div>
                  <div style={{ fontSize: '1.75rem', fontWeight: 'bold', color: 'var(--text)' }}>{evalSummary.averageLatency.toFixed(0)} ms</div>
                </div>
              </div>

              {/* Scenario Sheet */}
              <div>
                <h4 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.75rem' }}>📋 Scenario Benchmark Execution Sheet</h4>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', maxHeight: '400px', overflowY: 'auto', paddingRight: '0.25rem' }}>
                  {evalResults.map((result) => (
                    <div key={result.scenarioId} style={{
                      padding: '0.75rem 1rem',
                      borderRadius: 'var(--radius-sm)',
                      border: '1px solid var(--border)',
                      backgroundColor: 'var(--surface)',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center'
                    }}>
                      <div>
                        <div style={{ fontWeight: 600, fontSize: '0.95rem', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                          <span style={{ color: result.passed ? 'var(--success)' : 'var(--error)' }}>
                            {result.passed ? '●' : '■'}
                          </span>
                          {result.name}
                        </div>
                        <div style={{ fontSize: '0.8rem', opacity: 0.6, marginTop: '0.25rem', display: 'flex', gap: '0.75rem' }}>
                          <span>Latency: <strong>{result.latencyMs} ms</strong></span>
                          <span>Recall: <strong>{(result.metrics.retrievalRecall * 100).toFixed(0)}%</strong></span>
                          <span>Precision: <strong>{(result.metrics.contextPrecision * 100).toFixed(0)}%</strong></span>
                        </div>
                        {result.failureReason && (
                          <div style={{ fontSize: '0.75rem', color: 'var(--error)', marginTop: '0.25rem' }}>
                            ⚠️ {result.failureReason}
                          </div>
                        )}
                      </div>
                      
                      <span className="badge" style={{
                        backgroundColor: result.passed ? 'rgba(74, 117, 89, 0.15)' : 'rgba(179, 74, 60, 0.15)',
                        color: result.passed ? 'var(--success)' : 'var(--error)',
                        fontWeight: 'bold'
                      }}>
                        {result.passed ? 'PASSED' : 'FAILED'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

            </div>
          )}
        </section>
      </main>

      {/* Footer */}
      <footer className="footer">
        <div className="footer-links">
          <a href="https://github.com/Nataraj-EL/mnemos" target="_blank" rel="noopener noreferrer">
            GitHub Repository
          </a>
          <a href="mailto:natarajel.dev@gmail.com">Developer Contact</a>
        </div>
        <div>
          &copy; {new Date().getFullYear()} Mnemos. Architecture & Infrastructure established.
        </div>
      </footer>
    </div>
  );
}
