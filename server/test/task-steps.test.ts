import { describe, expect, it } from 'vitest';
import { buildToolResultTaskSteps } from '../src/managed/api.js';

describe('buildToolResultTaskSteps', () => {
  it('creates a tool_output step for string output', () => {
    const steps = buildToolResultTaskSteps({
      taskRunId: 'task-1',
      step: 2,
      toolName: 'read_page',
      result: { output: 'page text' } as any,
      durationMs: 123,
    });

    expect(steps).toEqual([
      {
        taskRunId: 'task-1',
        step: 2,
        status: 'tool_output',
        toolName: 'read_page',
        output: 'page text',
        durationMs: 123,
      },
    ]);
  });

  it('creates both tool_output and screenshot steps when both exist', () => {
    const steps = buildToolResultTaskSteps({
      taskRunId: 'task-2',
      step: 4,
      toolName: 'computer',
      result: {
        output: { clicked: true },
        screenshot: { data: 'base64-image' },
      } as any,
      durationMs: 456,
    });

    expect(steps).toEqual([
      {
        taskRunId: 'task-2',
        step: 4,
        status: 'tool_output',
        toolName: 'computer',
        output: JSON.stringify({ clicked: true }),
        durationMs: 456,
      },
      {
        taskRunId: 'task-2',
        step: 4,
        status: 'screenshot',
        toolName: 'computer',
        screenshot: 'base64-image',
        durationMs: 456,
      },
    ]);
  });

  it('skips empty output and only keeps screenshot artifacts', () => {
    const steps = buildToolResultTaskSteps({
      taskRunId: 'task-3',
      step: 1,
      toolName: 'screenshot',
      result: {
        output: '',
        screenshot: { data: 'shot' },
      } as any,
      durationMs: 20,
    });

    expect(steps).toEqual([
      {
        taskRunId: 'task-3',
        step: 1,
        status: 'screenshot',
        toolName: 'screenshot',
        screenshot: 'shot',
        durationMs: 20,
      },
    ]);
  });

  it('caps oversized tool output at 50KB', () => {
    const steps = buildToolResultTaskSteps({
      taskRunId: 'task-4',
      step: 9,
      toolName: 'read_console_messages',
      result: { output: 'x'.repeat(60000) } as any,
      durationMs: 99,
    });

    expect(steps).toHaveLength(1);
    expect(steps[0].status).toBe('tool_output');
    expect(steps[0].output).toHaveLength(50000);
  });
});
