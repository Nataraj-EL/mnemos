import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from './route';
import { testConnection } from '@/db';

// Mock database connection helper
vi.mock('@/db', () => ({
  testConnection: vi.fn(),
}));

describe('/api/health Route Handler', () => {
  beforeEach(() => {
    vi.mocked(testConnection).mockReset();
  });

  it('should return 200 and healthy status when database is connected', async () => {
    vi.mocked(testConnection).mockResolvedValueOnce(true);

    const response = await GET();
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.status).toBe('healthy');
    expect(data.services.app).toBe('running');
    expect(data.services.database).toBe('connected');
    expect(data.timestamp).toBeDefined();
  });

  it('should return 503 and unhealthy status when database is disconnected', async () => {
    vi.mocked(testConnection).mockResolvedValueOnce(false);

    const response = await GET();
    expect(response.status).toBe(503);

    const data = await response.json();
    expect(data.status).toBe('unhealthy');
    expect(data.services.app).toBe('running');
    expect(data.services.database).toBe('disconnected');
    expect(data.timestamp).toBeDefined();
  });
});
