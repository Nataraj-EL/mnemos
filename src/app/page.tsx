'use client';

import { useEffect, useState } from 'react';

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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    const fetchHealth = async () => {
      try {
        const response = await fetch('/api/health');
        const isOk = response.ok;
        const data = await response.json();
        setHealth(data);
        setError(!isOk);
      } catch (err) {
        console.error('Failed to fetch system status:', err);
        setError(true);
        setHealth(null);
      } finally {
        setLoading(false);
      }
    };

    fetchHealth();
    // Poll the health check API every 10 seconds
    const interval = setInterval(fetchHealth, 10000);
    return () => clearInterval(interval);
  }, []);

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
              loading ? 'warning' : error ? 'error' : isAppHealthy ? 'success' : 'error'
            }`}
            id="status-indicator-dot"
          ></span>
          <span id="status-indicator-text">
            {loading
              ? 'Checking status...'
              : error
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
                {loading ? 'LOADING' : isAppHealthy ? 'ONLINE' : 'OFFLINE'}
              </strong>
            </div>
            <div className="status-badge">
              <span>Neon Database:</span>
              <span className={`status-dot ${isDbConnected ? 'success' : 'error'}`}></span>
              <strong style={{ marginLeft: '0.25rem' }}>
                {loading ? 'LOADING' : isDbConnected ? 'CONNECTED' : 'DISCONNECTED'}
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
                Sprint 2
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
