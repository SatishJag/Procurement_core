import { AuditLog } from './audit';
// Shared kernel: tables, clock, ids, the audit chain and domain events.
// Capabilities live in modules/ as plain functions over this object, so adding
// one never edits this file.
export class Platform {
    audit = new AuditLog();
    fx; // AED per unit of currency
    clock;
    #tables = new Map();
    #handlers = new Map();
    #seq = 0;
    constructor(seed, clock = () => new Date().toISOString()) {
        for (const [name, rows] of Object.entries(seed.tables)) {
            for (const row of rows)
                this.table(name).set(row.id, structuredClone(row));
        }
        this.fx = seed.fx;
        this.clock = clock;
    }
    // ponytail: in-memory tables. A Postgres adapter replaces the backing store here; module code keeps calling table().
    table(name) {
        if (!this.#tables.has(name))
            this.#tables.set(name, new Map());
        return this.#tables.get(name);
    }
    get users() { return this.table('users'); }
    get projects() { return this.table('projects'); }
    get suppliers() { return this.table('suppliers'); }
    get packages() { return this.table('packages'); }
    get today() { return this.clock().slice(0, 10); }
    id(prefix) { return `${prefix}-${String(++this.#seq).padStart(4, '0')}`; }
    get(table, id) {
        const row = this.table(table).get(id);
        if (!row)
            throw new Error(`${table} ${id} not found`);
        return row;
    }
    sees(user, projectId) { return user.projects.includes('*') || user.projects.includes(projectId); }
    // Every state change goes through here: written to the audit chain, then
    // published to subscribed modules (contracts react to awards, and so on).
    emit(user, action, entity, data = {}) {
        const event = this.audit.append(user.id, action, entity, data, this.clock());
        for (const handler of this.#handlers.get(action) ?? [])
            handler(event, this);
        return event;
    }
    // ponytail: synchronous in-process bus. Move to an outbox + Service Bus when external integrations land.
    on(action, handler) {
        this.#handlers.set(action, [...(this.#handlers.get(action) ?? []), handler]);
    }
}
