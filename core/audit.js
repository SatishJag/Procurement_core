import { createHash } from 'node:crypto.js';
export const sha256 = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const digest = (e) => sha256([e.seq, e.at, e.actor, e.action, e.entity, e.data, e.prev]);
// Append-only, hash-chained audit trail: editing or removing any event breaks verify().
export class AuditLog {
    events = [];
    append(actor, action, entity, data, at) {
        const e = { seq: this.events.length + 1, at, actor, action, entity, data: structuredClone(data), prev: this.events.at(-1)?.hash ?? 'GENESIS' };
        const event = Object.freeze({ ...e, hash: digest(e) });
        this.events.push(event);
        return event;
    }
    verify() {
        for (const [i, e] of this.events.entries()) {
            const prev = i ? this.events[i - 1].hash : 'GENESIS';
            if (e.seq !== i + 1 || e.prev !== prev || digest(e) !== e.hash)
                return { ok: false, brokenAt: i + 1 };
        }
        return { ok: true };
    }
    for(entity) {
        return this.events.filter(e => e.entity === entity);
    }
}
