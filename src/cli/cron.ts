import { Command } from 'commander';
import { parseDurationMs, cronExpressionMinIntervalMs } from '../bus/cron-state.js';

/**
 * `cortextos cron` — CLI surface for the canonical daemon schedule parser.
 *
 * Out-of-process self-healing monitors (bash/python) used to re-implement
 * cron-interval parsing and could silently drift from the daemon's parser
 * (e.g. the cannametrics 4h-shorthand false-stale, fixed db19f5ac). This
 * subcommand exposes the single source of truth — parseDurationMs +
 * cronExpressionMinIntervalMs from src/bus/cron-state.ts — so scripts CALL
 * the canonical parser instead of re-implementing it.
 */
export const cronCommand = new Command('cron').description(
  'Canonical cron/schedule helpers (parse-interval, etc.)',
);

const UNIT_DIVISORS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};

cronCommand
  .command('parse-interval')
  .description(
    'Resolve a schedule (shorthand like "4h"/"30m" or a 5-field cron expression) ' +
      'to its firing interval using the canonical daemon parser',
  )
  .argument('<schedule>', 'Interval shorthand (e.g. "4h", "30m", "1d", "2w") or 5-field cron expression')
  .option('--unit <unit>', 'Output unit: ms, s, m, or h', 'm')
  .option('--format <format>', 'Output format: text or json', 'text')
  .action((schedule: string, options: { unit: string; format: string }) => {
    const unit = options.unit;
    if (!(unit in UNIT_DIVISORS)) {
      process.stderr.write(`Error: unknown --unit '${unit}' (expected ms, s, m, or h)\n`);
      process.exit(1);
    }

    // 1) Try interval shorthand (the canonical parseDurationMs).
    let ms = parseDurationMs(schedule);
    let source: 'shorthand' | 'cron-expression' = 'shorthand';

    // 2) Fall back to a 5-field cron expression. Only treat input that actually
    //    has 5 whitespace-separated fields as a cron expression — otherwise
    //    cronExpressionMinIntervalMs would silently return its 48h fallback for
    //    garbage input and mask a real parse failure.
    if (Number.isNaN(ms)) {
      const isFiveField = schedule.trim().split(/\s+/).length === 5;
      if (isFiveField) {
        ms = cronExpressionMinIntervalMs(schedule);
        source = 'cron-expression';
      }
    }

    if (Number.isNaN(ms)) {
      process.stderr.write(
        `Error: could not parse schedule '${schedule}' (expected shorthand like "4h" or a 5-field cron expression)\n`,
      );
      process.exit(1);
    }

    const value = ms / UNIT_DIVISORS[unit];

    if (options.format === 'json') {
      console.log(
        JSON.stringify({
          schedule,
          source,
          ms,
          seconds: ms / 1_000,
          minutes: ms / 60_000,
          hours: ms / 3_600_000,
          unit,
          value,
        }),
      );
      return;
    }

    // text format: print just the number so scripts can capture it directly,
    // e.g. MIN=$(cortextos cron parse-interval '4h')
    console.log(String(value));
  });
