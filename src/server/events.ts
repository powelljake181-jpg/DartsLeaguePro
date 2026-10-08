import { EventEmitter } from "node:events";

/**
 * In-process change notifications for live fixtures. Route handlers publish
 * after a scoring change commits; the SSE stream subscribes.
 *
 * Single-instance for now. To run several app instances, replace the emitter
 * with Postgres LISTEN/NOTIFY (same two functions), as described in
 * docs/ARCHITECTURE.md §5.
 */
const g = globalThis as unknown as { __dartsEvents?: EventEmitter };
const bus = (g.__dartsEvents ??= new EventEmitter().setMaxListeners(0));

export function publishFixtureChanged(fixtureId: string): void {
  bus.emit(`fixture:${fixtureId}`);
}

export function onFixtureChanged(fixtureId: string, listener: () => void): () => void {
  bus.on(`fixture:${fixtureId}`, listener);
  return () => bus.off(`fixture:${fixtureId}`, listener);
}
