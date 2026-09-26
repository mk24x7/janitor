// Small shared helpers: durations, concurrency, colours, prompts.

import { createInterface } from 'node:readline/promises';
import { styleText } from 'node:util';
import { UsageError } from './errors.js';

const DURATION = /^(\d+)\s*(y|mo|m|w|d)$/i;

/**
 * Parses durations such as 3y, 18mo (or 18m), 6w, 90d.
 * @returns {{ amount: number, unit: 'y'|'mo'|'w'|'d', text: string }}
 */
export function parseDuration(text) {
  const match = String(text ?? '').trim().match(DURATION);
  if (!match || Number(match[1]) <= 0) {
    throw new UsageError(`invalid duration "${text}"; use forms like 3y, 18mo, 6w or 90d`);
  }
  let unit = match[2].toLowerCase();
  if (unit === 'm') unit = 'mo';
  return { amount: Number(match[1]), unit, text: `${match[1]}${unit}` };
}

/**
 * Returns the instant `duration` before `now`, using calendar arithmetic in
 * UTC for years and months (so 3y before 2026-02-28 is 2023-02-28, and 1y
 * before 2024-02-29 clamps to 2023-02-28).
 */
export function subtractDuration(now, duration) {
  const date = new Date(now);
  const { amount, unit } = typeof duration === 'string' ? parseDuration(duration) : duration;
  if (unit === 'd' || unit === 'w') {
    return new Date(date.getTime() - amount * (unit === 'w' ? 7 : 1) * 86_400_000);
  }
  const months = unit === 'y' ? amount * 12 : amount;
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() - months;
  const targetYear = y + Math.floor(m / 12);
  const targetMonth = ((m % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const day = Math.min(date.getUTCDate(), lastDay);
  return new Date(
    Date.UTC(
      targetYear,
      targetMonth,
      day,
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    ),
  );
}

/** True when `iso` is strictly before the cutoff. Missing dates count as old. */
export function isBefore(iso, cutoff) {
  if (!iso) return true;
  return new Date(iso).getTime() < cutoff.getTime();
}

export function formatDate(iso) {
  return iso ? String(iso).slice(0, 10) : 'never';
}

/** Maps with at most `limit` promises in flight, preserving order. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const i = index;
      index += 1;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

export function createStyler(enabled) {
  const paint = (format) => (text) => (enabled ? styleText(format, String(text), { validateStream: false }) : String(text));
  return {
    enabled,
    bold: paint('bold'),
    dim: paint('dim'),
    red: paint('red'),
    yellow: paint('yellow'),
    green: paint('green'),
    cyan: paint('cyan'),
    magenta: paint('magenta'),
  };
}

export function colorEnabled({ noColor, stream, env = process.env }) {
  if (noColor) return false;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0') return true;
  return Boolean(stream && stream.isTTY);
}

/** Asks a yes/no question on the given streams. Defaults to no. */
export async function confirm(question, { input = process.stdin, output = process.stderr } = {}) {
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/** Splits an argument string the way a POSIX shell would for simple cases. */
export function splitArgs(text) {
  const args = [];
  let current = '';
  let quote = null;
  let started = false;
  const input = String(text ?? '');
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < input.length) current += input[++i];
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (ch === '\\' && i + 1 < input.length) {
      current += input[++i];
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) args.push(current);
      current = '';
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (quote) throw new UsageError(`unterminated ${quote} quote in arguments`);
  if (started) args.push(current);
  return args;
}

export function plural(n, word, pluralWord = `${word}s`) {
  return `${n} ${n === 1 ? word : pluralWord}`;
}
