import { describe, it, expect } from 'vitest';
import { EXIT_OK, EXIT_TASK_ERROR, EXIT_CLI_ERROR, EXIT_TIMEOUT } from './exit-codes.js';

describe('exit-codes', () => {
  it('defines the 4 canonical exit codes', () => {
    expect(EXIT_OK).toBe(0);
    expect(EXIT_TASK_ERROR).toBe(1);
    expect(EXIT_CLI_ERROR).toBe(2);
    expect(EXIT_TIMEOUT).toBe(3);
  });
});
