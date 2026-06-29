/**
 * tests/unit/cli/cron-parse-interval.test.ts
 *
 * Tests `cortextos cron parse-interval` — the CLI surface that exposes the
 * canonical daemon schedule parser (parseDurationMs + cronExpressionMinIntervalMs)
 * so out-of-process self-healing scripts call the single source of truth
 * instead of re-implementing interval parsing (class-killer for the
 * cannametrics 4h-shorthand false-stale drift, fixed db19f5ac).
 *
 * cronCommand is a module-level singleton; we invoke it via parseAsync, spy on
 * console.log to capture stdout, and mock process.exit to throw on error paths.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { cronCommand } from '../../../src/cli/cron';

function mockExit(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`__PROCESS_EXIT_${code}__`);
  }) as never);
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** Invoke `cron parse-interval` with the given args and return captured stdout. */
async function run(...args: string[]): Promise<string[]> {
  const out: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => {
    out.push(String(msg));
  });
  await cronCommand.parseAsync(['node', 'cortextos', 'parse-interval', ...args]);
  return out;
}

describe('cron parse-interval — shorthand', () => {
  it('resolves "4h" to 240 minutes by default', async () => {
    const out = await run('4h');
    expect(out).toEqual(['240']);
  });

  it('resolves "30m" to 30 minutes', async () => {
    const out = await run('30m');
    expect(out).toEqual(['30']);
  });

  it('resolves "1d" to 1440 minutes', async () => {
    const out = await run('1d');
    expect(out).toEqual(['1440']);
  });

  it('resolves "2w" to 20160 minutes', async () => {
    const out = await run('2w');
    expect(out).toEqual(['20160']);
  });
});

describe('cron parse-interval — units', () => {
  it('--unit ms returns milliseconds', async () => {
    const out = await run('4h', '--unit', 'ms');
    expect(out).toEqual([String(4 * 3_600_000)]);
  });

  it('--unit s returns seconds', async () => {
    const out = await run('30m', '--unit', 's');
    expect(out).toEqual([String(30 * 60)]);
  });

  it('--unit h returns hours', async () => {
    const out = await run('1d', '--unit', 'h');
    expect(out).toEqual(['24']);
  });

  it('rejects an unknown unit', async () => {
    const exitSpy = mockExit();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(run('4h', '--unit', 'fortnights')).rejects.toThrow('__PROCESS_EXIT_1__');
    expect(exitSpy).toHaveBeenCalledWith(1);
    errSpy.mockRestore();
    stderrSpy.mockRestore();
  });
});

describe('cron parse-interval — cron expressions', () => {
  it('resolves "*/5 * * * *" to 5 minutes', async () => {
    const out = await run('*/5 * * * *');
    expect(out).toEqual(['5']);
  });

  it('resolves a daily fixed-hour expression to 1440 minutes', async () => {
    const out = await run('0 8 * * *');
    expect(out).toEqual(['1440']);
  });

  it('resolves "0 */2 * * *" to 120 minutes', async () => {
    const out = await run('0 */2 * * *');
    expect(out).toEqual(['120']);
  });
});

describe('cron parse-interval — JSON output', () => {
  it('emits structured fields with the shorthand source', async () => {
    const out = await run('4h', '--format', 'json');
    const parsed = JSON.parse(out[0]);
    expect(parsed).toMatchObject({
      schedule: '4h',
      source: 'shorthand',
      ms: 4 * 3_600_000,
      minutes: 240,
      hours: 4,
      unit: 'm',
      value: 240,
    });
  });

  it('marks a cron expression with the cron-expression source', async () => {
    const out = await run('*/5 * * * *', '--format', 'json');
    const parsed = JSON.parse(out[0]);
    expect(parsed.source).toBe('cron-expression');
    expect(parsed.minutes).toBe(5);
  });
});

describe('cron parse-interval — errors', () => {
  it('exits non-zero on unparseable garbage', async () => {
    const exitSpy = mockExit();
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(run('not-a-schedule')).rejects.toThrow('__PROCESS_EXIT_1__');
    expect(exitSpy).toHaveBeenCalledWith(1);
    stderrSpy.mockRestore();
  });

  it('does not treat non-5-field garbage as a 48h cron fallback', async () => {
    const exitSpy = mockExit();
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // "abc def" is 2 fields — must error, NOT silently resolve to 48h.
    await expect(run('abc def')).rejects.toThrow('__PROCESS_EXIT_1__');
    expect(exitSpy).toHaveBeenCalledWith(1);
    stderrSpy.mockRestore();
  });
});
