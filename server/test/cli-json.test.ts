import { describe, expect, it } from 'vitest';
import {
  buildScreenshotPayload,
  buildStatusPayload,
  buildStopPayload,
  buildTaskCompletePayload,
  buildTaskErrorPayload,
} from '../src/cli/json-output.js';

describe('CLI JSON output helpers', () => {
  it('builds task completion payloads', () => {
    expect(buildTaskCompletePayload('abc123', { title: 'Example Domain' })).toEqual({
      session_id: 'abc123',
      status: 'completed',
      result: { title: 'Example Domain' },
    });
  });

  it('builds task error payloads', () => {
    expect(buildTaskErrorPayload('abc123', 'something broke')).toEqual({
      session_id: 'abc123',
      status: 'error',
      error: 'something broke',
    });
  });

  it('passes through session status payloads unchanged', () => {
    const status = {
      session_id: 'abc123',
      status: 'running',
      task: 'Go to example.com',
    };

    expect(buildStatusPayload(status as any)).toEqual(status);
    expect(buildStatusPayload([status] as any)).toEqual([status]);
  });

  it('builds stop payloads', () => {
    expect(buildStopPayload('abc123')).toEqual({
      session_id: 'abc123',
      status: 'stopped',
      removed: false,
    });

    expect(buildStopPayload('abc123', true)).toEqual({
      session_id: 'abc123',
      status: 'stopped',
      removed: true,
    });
  });

  it('builds screenshot payloads', () => {
    expect(buildScreenshotPayload('abc123', '/tmp/shot.png')).toEqual({
      session_id: 'abc123',
      screenshot_path: '/tmp/shot.png',
    });
  });
});
