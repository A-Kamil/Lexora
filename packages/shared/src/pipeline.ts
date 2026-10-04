/**
 * Intake pipeline contract (webhook -> worker): storage/queue ports and their in-memory implementation.
 * Kept on a subpath because its names (Person, Urgency, CaseContext) overlap the Postgres domain model in
 * ./domain.ts; the two converge when packages/db implements CaseStore.
 */
export type * from './ports.js';
export { MemoryStore, MemoryQueue } from './memory.js';
