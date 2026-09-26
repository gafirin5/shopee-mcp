import os from 'node:os';
import path from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

/**
 * Account-safety gate: the single choke point every browser operation passes
 * through. All traffic runs on ONE Shopee account + ONE IP, so the realistic
 * ban triggers are behavioural — request rate, fixed cadences, and hammering
 * after an anti-bot block. This module addresses exactly those:
 *
 *  1. minimum spacing between operations, jittered (no fixed rhythm),
 *  2. hourly/daily budgets (persisted across server restarts),
 *  3. a circuit breaker that cools everything down when Shopee pushes back
 *     (anti-bot error 90309999 / auth-required / repeated timeouts).
 *
 * It reduces risk; it cannot eliminate it. Only ever run this against your
 * own account, at low volume.
 */

export type OpKind = 'read' | 'write';

export interface SafetyConfig {
  /** Base minimum spacing between read ops (ms); jitter adds up to `readSpreadMs`. */
  readSpacingMs: number;
  readSpreadMs: number;
  /** Base minimum spacing between write ops (ms). */
  writeSpacingMs: number;
  writeSpreadMs: number;
  /** Max read ops in any rolling hour. */
  readMaxPerHour: number;
  /** Max write ops in any rolling hour / calendar day. */
  writeMaxPerHour: number;
  writeMaxPerDay: number;
  /** Circuit-breaker cooldown after an anti-bot block (ms). */
  cooldownMs: number;
}

export const DEFAULT_SAFETY: SafetyConfig = {
  readSpacingMs: 3000,
  readSpreadMs: 3000,
  writeSpacingMs: 60_000,
  writeSpreadMs: 120_000,
  readMaxPerHour: 30,
  writeMaxPerHour: 10,
  writeMaxPerDay: 30,
  cooldownMs: 10 * 60_000,
};

function envInt(name: string, fallback: number): number {
  const v = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function configFromEnv(): SafetyConfig {
  return {
    readSpacingMs: envInt('SHOPEE_READ_SPACING_MS', DEFAULT_SAFETY.readSpacingMs),
    readSpreadMs: envInt('SHOPEE_READ_SPREAD_MS', DEFAULT_SAFETY.readSpreadMs),
    writeSpacingMs: envInt('SHOPEE_WRITE_SPACING_MS', DEFAULT_SAFETY.writeSpacingMs),
    writeSpreadMs: envInt('SHOPEE_WRITE_SPREAD_MS', DEFAULT_SAFETY.writeSpreadMs),
    readMaxPerHour: envInt('SHOPEE_READ_MAX_PER_HOUR', DEFAULT_SAFETY.readMaxPerHour),
    writeMaxPerHour: envInt('SHOPEE_WRITE_MAX_PER_HOUR', DEFAULT_SAFETY.writeMaxPerHour),
    writeMaxPerDay: envInt('SHOPEE_WRITE_MAX_PER_DAY', DEFAULT_SAFETY.writeMaxPerDay),
    cooldownMs: envInt('SHOPEE_COOLDOWN_MS', DEFAULT_SAFETY.cooldownMs),
  };
}

export class RateLimitError extends Error {
  constructor(
    message: string,
    public readonly retryAtMs: number,
  ) {
    super(message);
    this.name = 'RateLimitError';
  }
}

export class CooldownError extends Error {
  constructor(
    message: string,
    public readonly untilMs: number,
  ) {
    super(message);
    this.name = 'CooldownError';
  }
}

/** Anti-bot / hard-block signatures that trip the breaker immediately. */
const BLOCKED_RE = /anti-bot|90309999|blocked|session is not available|not signed in/i;

export interface SafetyStatus {
  blockedUntilMs: number | null;
  readsLastHour: number;
  writesLastHour: number;
  writesToday: number;
  nextReadAllowedMs: number;
  nextWriteAllowedMs: number;
}

interface PersistedState {
  date: string;
  writesToday: number;
  /** Rolling op log: [epochMs, kind]. Pruned to the last hour on load/save. */
  ops: Array<[number, OpKind]>;
}

function today(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export interface SafetyGateOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Usage persistence path; null disables persistence (tests). */
  persistPath?: string | null;
  config?: Partial<SafetyConfig>;
}

export function createSafetyGate(options: SafetyGateOptions = {}) {
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const cfg: SafetyConfig = { ...configFromEnv(), ...options.config };
  const persistPath =
    options.persistPath === undefined
      ? path.join(os.homedir(), '.shopee-mcp', 'usage.json')
      : options.persistPath;

  // ── state ──
  let state: PersistedState = { date: today(now()), writesToday: 0, ops: [] };
  let lastOpAt: Record<OpKind, number> = { read: 0, write: 0 };
  let blockedUntil = 0;
  let consecutiveTimeouts = 0;

  function prune(): void {
    const cutoff = now() - 60 * 60_000;
    state.ops = state.ops.filter(([t]) => t >= cutoff);
    const d = today(now());
    if (state.date !== d) {
      state.date = d;
      state.writesToday = 0;
    }
  }

  function load(): void {
    if (!persistPath) return;
    try {
      const raw = JSON.parse(readFileSync(persistPath, 'utf-8')) as PersistedState;
      if (raw && Array.isArray(raw.ops)) {
        state = { date: raw.date ?? today(now()), writesToday: raw.writesToday ?? 0, ops: raw.ops };
        prune();
      }
    } catch {
      // first run or unreadable file — start fresh
    }
  }

  function save(): void {
    if (!persistPath) return;
    try {
      mkdirSync(path.dirname(persistPath), { recursive: true });
      writeFileSync(persistPath, JSON.stringify(state), 'utf-8');
    } catch {
      // persistence is best-effort; the in-memory counters still protect us
    }
  }

  load();

  function jitteredSpacing(kind: OpKind): number {
    const base = kind === 'read' ? cfg.readSpacingMs : cfg.writeSpacingMs;
    const spread = kind === 'read' ? cfg.readSpreadMs : cfg.writeSpreadMs;
    return base + Math.random() * spread;
  }

  function countKind(kind: OpKind): number {
    return state.ops.filter(([, k]) => k === kind).length;
  }

  function hourWindowEnd(): number {
    const oldest = state.ops.length ? state.ops[0][0] : now();
    return oldest + 60 * 60_000;
  }

  function dayEnd(): number {
    const d = new Date(now());
    const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
    return next.getTime();
  }

  function fmtTime(ms: number): string {
    return new Date(ms).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  }

  return {
    /**
     * Wait out the spacing for `kind`, enforce budgets, and record the op.
     * Throws CooldownError (breaker tripped) or RateLimitError (budget spent).
     */
    async acquire(kind: OpKind): Promise<void> {
      const t = now();

      if (t < blockedUntil) {
        throw new CooldownError(
          `🧊 Safety cooldown active until ${fmtTime(blockedUntil)} — Shopee pushed back ` +
            'recently. Wait it out instead of retrying; forcing it now risks the account.',
          blockedUntil,
        );
      }
      if (blockedUntil !== 0 && t >= blockedUntil) blockedUntil = 0; // half-open

      prune();

      const used = countKind(kind);
      const maxPerHour = kind === 'read' ? cfg.readMaxPerHour : cfg.writeMaxPerHour;
      if (used >= maxPerHour) {
        const retryAt = hourWindowEnd();
        throw new RateLimitError(
          `📉 ${kind} budget spent: ${used}/${maxPerHour} ${kind} ops in the last hour. ` +
            `Next slot around ${fmtTime(retryAt)}.`,
          retryAt,
        );
      }
      if (kind === 'write' && state.writesToday >= cfg.writeMaxPerDay) {
        const retryAt = dayEnd();
        throw new RateLimitError(
          `📉 Daily write budget spent: ${state.writesToday}/${cfg.writeMaxPerDay} today. ` +
            `Resets at ${fmtTime(retryAt)}.`,
          retryAt,
        );
      }

      const last = lastOpAt[kind];
      const waitUntil = last + jitteredSpacing(kind);
      const wait = Math.max(0, waitUntil - now());
      if (wait > 0) await sleep(wait);

      const ts = now();
      lastOpAt[kind] = ts;
      state.ops.push([ts, kind]);
      if (kind === 'write') state.writesToday += 1;
      save();
    },

    /** Feed outcomes into the circuit breaker. */
    reportFailure(err: unknown): void {
      const msg = err instanceof Error ? err.message : String(err);
      if (BLOCKED_RE.test(msg)) {
        blockedUntil = now() + cfg.cooldownMs;
        consecutiveTimeouts = 0;
        return;
      }
      if (/timeout/i.test(msg)) {
        consecutiveTimeouts += 1;
        if (consecutiveTimeouts >= 2) {
          blockedUntil = now() + cfg.cooldownMs;
          consecutiveTimeouts = 0;
        }
      }
    },

    reportSuccess(): void {
      consecutiveTimeouts = 0;
    },

    status(): SafetyStatus {
      prune();
      return {
        blockedUntilMs: blockedUntil > now() ? blockedUntil : null,
        readsLastHour: countKind('read'),
        writesLastHour: countKind('write'),
        writesToday: state.writesToday,
        nextReadAllowedMs: Math.max(lastOpAt.read + jitteredSpacing('read'), now()),
        nextWriteAllowedMs: Math.max(lastOpAt.write + jitteredSpacing('write'), now()),
      };
    },

    /** Test hook: inspect raw spacing state. */
    _state(): { blockedUntil: number; consecutiveTimeouts: number; state: PersistedState } {
      return { blockedUntil, consecutiveTimeouts, state };
    },
  };
}

export type SafetyGate = ReturnType<typeof createSafetyGate>;
