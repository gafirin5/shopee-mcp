import os from 'node:os';
import path from 'node:path';
import { mkdirSync, appendFileSync } from 'node:fs';

/**
 * Append-only audit trail for account-touching automation. Every write action
 * (and every anti-bot block) lands in ~/.shopee-mcp/audit.log as one JSON
 * line, so the user can always answer "what did the automation actually do?".
 * Best-effort: an audit failure never breaks the operation it records.
 */
const AUDIT_PATH = path.join(os.homedir(), '.shopee-mcp', 'audit.log');

export interface AuditEntry {
  ts: string;
  kind: 'write' | 'read' | 'block';
  tool: string;
  ok: boolean;
  /** Compact argument summary — never credentials, never full payloads. */
  detail?: string;
  error?: string;
}

export function audit(entry: Omit<AuditEntry, 'ts'>): void {
  try {
    mkdirSync(path.dirname(AUDIT_PATH), { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    appendFileSync(AUDIT_PATH, line + '\n', 'utf-8');
  } catch {
    // never let audit I/O break the tool
  }
}
