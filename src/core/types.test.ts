import { describe, it, expect } from 'vitest';
import { isValidMemoryType, MEMORY_TYPES } from './types';

describe('Domain Type Validation', () => {
  it('should validate all supported MemoryType values', () => {
    for (const type of MEMORY_TYPES) {
      expect(isValidMemoryType(type)).toBe(true);
    }
  });

  it('should reject unsupported memory type values', () => {
    expect(isValidMemoryType('STORY')).toBe(false);
    expect(isValidMemoryType('OPINION')).toBe(false);
    expect(isValidMemoryType('')).toBe(false);
    expect(isValidMemoryType('fact')).toBe(false); // Case sensitive check
  });
});
