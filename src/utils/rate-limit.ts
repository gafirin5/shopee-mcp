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
  /**
   * Max Shopee API requests in any rolling hour (0 = report only, no cap).
   *
   * Op budgets are what the numbers above count, but one op is rarely one
   * request: a variant stock lookup clicks a dozen options, `add_to_cart` walks
   * a whole buy box, and `shopee_video_probe` loads four pages. This is the
   * budget that actually tracks traffic to Shopee.
   */
  apiRequestsMaxPerHour: number;
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
  apiRequestsMaxPerHour: 0,
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
    // 0 is a meaningful value here (report only), so it is not passed through
    // envInt — which treats 0 as "unset" and would fall back to the default.
    apiRequestsMaxPerHour: (() => {
      const v = parseInt(process.env.SHOPEE_API_REQUESTS_MAX_PER_HOUR ?? '', 10);
      return Number.isFinite(v) && v > 0 ? v : DEFAULT_SAFETY.apiRequestsMaxPerHour;
    })(),
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
  /** Shopee API requests seen in the last rolling hour (see noteApiRequest). */
  apiRequestsLastHour: number;
  /**
   * The budgets this gate actually enforces. Reported so `safety_status` shows
   * the user's configured limits instead of the hardcoded defaults it used to
   * print (they lied whenever an env override was set).
   */
  limits: {
    readMaxPerHour: number;
    writeMaxPerHour: number;
    writeMaxPerDay: number;
    /** 0 means "report only" — the request count is shown but never enforced. */
    apiRequestsMaxPerHour: number;
  };
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
  const lastOpAt: Record<OpKind, number> = { read: 0, write: 0 };
  let blockedUntil = 0;
  let consecutiveTimeouts = 0;
  // Timestamps of every Shopee API request the browser made (not persisted —
  // the durable budget is the op log above; this is traffic visibility plus an
  // optional cap). Kept pruned to the last hour, so it stays small.
  let apiRequests: number[] = [];

  function prune(): void {
    const cutoff = now() - 60 * 60_000;
    state.ops = state.ops.filter(([t]) => t >= cutoff);
    apiRequests = apiRequests.filter((t) => t >= cutoff);
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

  function hourWindowEnd(kind: OpKind): number {
    // The oldest *of this kind* — the rolling hour frees up one slot at a time,
    // so mixing kinds would report a reset time that frees nothing.
    const oldest = state.ops.find(([, k]) => k === kind);
    return (oldest ? oldest[0] : now()) + 60 * 60_000;
  }

  function dayEnd(): number {
    const d = new Date(now());
    const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
    return next.getTime();
  }

  /**
   * "14:05" in the machine's own timezone — the same clock the person reading
   * the cooldown message is looking at. (`id-ID` was used here before, which
   * only changed the digits' formatting, not the timezone, and made every
   * message look Indonesia-specific on the other storefronts.)
   */
  function fmtTime(ms: number): string {
    return new Date(ms).toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
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
        const retryAt = hourWindowEnd(kind);
        throw new RateLimitError(
          `📉 ${kind} budget spent: ${used}/${maxPerHour} ${kind} ops in the last hour. ` +
            `Next slot around ${fmtTime(retryAt)}.`,
          retryAt,
        );
      }
      // Optional traffic cap: op budgets say how many *operations* may run, this
      // says how many requests they may collectively fire (see SafetyConfig).
      if (cfg.apiRequestsMaxPerHour > 0 && apiRequests.length >= cfg.apiRequestsMaxPerHour) {
        const retryAt = (apiRequests[0] ?? now()) + 60 * 60_000;
        throw new RateLimitError(
          `📉 Request budget spent: ${apiRequests.length}/${cfg.apiRequestsMaxPerHour} Shopee API ` +
            `requests in the last hour. Next slot around ${fmtTime(retryAt)}.`,
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

    /**
     * Record one Shopee API request the browser made. Called from the
     * context-level response listener, so it costs nothing to instrument every
     * endpoint. Never throws.
     */
    noteApiRequest(): void {
      const t = now();
      apiRequests.push(t);
      // Cheap guard for a runaway page: keep only the rolling hour.
      if (apiRequests.length > 2000) apiRequests = apiRequests.filter((x) => x >= t - 60 * 60_000);
    },

    status(): SafetyStatus {
      prune();
      return {
        apiRequestsLastHour: apiRequests.length,
        blockedUntilMs: blockedUntil > now() ? blockedUntil : null,
        readsLastHour: countKind('read'),
        writesLastHour: countKind('write'),
        writesToday: state.writesToday,
        nextReadAllowedMs: Math.max(lastOpAt.read + jitteredSpacing('read'), now()),
        nextWriteAllowedMs: Math.max(lastOpAt.write + jitteredSpacing('write'), now()),
        limits: {
          readMaxPerHour: cfg.readMaxPerHour,
          writeMaxPerHour: cfg.writeMaxPerHour,
          writeMaxPerDay: cfg.writeMaxPerDay,
          apiRequestsMaxPerHour: cfg.apiRequestsMaxPerHour,
        },
      };
    },

    /** Test hook: inspect raw spacing state. */
    _state(): { blockedUntil: number; consecutiveTimeouts: number; state: PersistedState } {
      return { blockedUntil, consecutiveTimeouts, state };
    },
  };
}

export type SafetyGate = ReturnType<typeof createSafetyGate>;
