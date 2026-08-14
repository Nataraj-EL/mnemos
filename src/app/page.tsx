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
                disabled={ingestLoading || !contentInput.trim()}
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
