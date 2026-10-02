import { AuditLog } from './audit';
import type { AuditEvent, Package, Project, Supplier, User } from './types';

// Sample or migrated data: one array of rows per table. New modules seed their own tables.
export interface Seed { fx: Record<string, number>; tables: Record<string, { id: string }[]> }
export type Handler = (event: AuditEvent, p: Platform) => void;

// Shared kernel: tables, clock, ids, the audit chain and domain events.
// Capabilities live in modules/ as plain functions over this object, so adding
// one never edits this file.
export class Platform {
  readonly audit = new AuditLog();
  readonly fx: Record<string, number>;   // AED per unit of currency
  readonly clock: () => string;
  #tables = new Map<string, Map<string, unknown>>();
  #handlers = new Map<string, Handler[]>();
  #seq = 0;

  constructor(seed: Seed, clock = () => new Date().toISOString()) {
    for (const [name, rows] of Object.entries(seed.tables)) {
      for (const row of rows) this.table(name).set(row.id, structuredClone(row));
    }
    this.fx = seed.fx;
    this.clock = clock;
  }

  // ponytail: in-memory tables. A Postgres adapter replaces the backing store here; module code keeps calling table().
  table<T>(name: string): Map<string, T> {
    if (!this.#tables.has(name)) this.#tables.set(name, new Map());
    return this.#tables.get(name) as Map<string, T>;
  }

  get users() { return this.table<User>('users'); }
  get projects() { return this.table<Project>('projects'); }
  get suppliers() { return this.table<Supplier>('suppliers'); }
  get packages() { return this.table<Package>('packages'); }
  get today() { return this.clock().slice(0, 10); }

  id(prefix: string) { return `${prefix}-${String(++this.#seq).padStart(4, '0')}`; }

  get<T>(table: string, id: string): T {
    const row = this.table<T>(table).get(id);
    if (!row) throw new Error(`${table} ${id} not found`);
    return row;
  }

  sees(user: User, projectId: string) { return user.projects.includes('*') || user.projects.includes(projectId); }

  // Every state change goes through here: written to the audit chain, then
  // published to subscribed modules (contracts react to awards, and so on).
  emit(user: User, action: string, entity: string, data: unknown = {}) {
    const event = this.audit.append(user.id, action, entity, data, this.clock());
    for (const handler of this.#handlers.get(action) ?? []) handler(event, this);
    return event;
  }

  // ponytail: synchronous in-process bus. Move to an outbox + Service Bus when external integrations land.
  on(action: string, handler: Handler) {
    this.#handlers.set(action, [...(this.#handlers.get(action) ?? []), handler]);
  }
}
