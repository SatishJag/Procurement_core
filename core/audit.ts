import { createHash } from 'node:crypto';
import type { AuditEvent } from './types.ts';

export const sha256 = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const digest = (e: Omit<AuditEvent, 'hash'>) => sha256([e.seq, e.at, e.actor, e.action, e.entity, e.data, e.prev]);

// Append-only, hash-chained audit trail: editing or removing any event breaks verify().
export class AuditLog {
  readonly events: AuditEvent[] = [];

  append(actor: string, action: string, entity: string, data: unknown, at: string) {
    const e = { seq: this.events.length + 1, at, actor, action, entity, data: structuredClone(data), prev: this.events.at(-1)?.hash ?? 'GENESIS' };
    const event = Object.freeze({ ...e, hash: digest(e) });
    this.events.push(event);
    return event;
  }

  verify(): { ok: true } | { ok: false; brokenAt: number } {
    for (const [i, e] of this.events.entries()) {
      const prev = i ? this.events[i - 1].hash : 'GENESIS';
      if (e.seq !== i + 1 || e.prev !== prev || digest(e) !== e.hash) return { ok: false, brokenAt: i + 1 };
    }
    return { ok: true };
  }

  for(entity: string) {
    return this.events.filter(e => e.entity === entity);
  }
}
