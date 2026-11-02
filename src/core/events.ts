import type { SimEventName, SimEvents } from './types';

type Handler<K extends SimEventName> = (payload: SimEvents[K]) => void;

/** Minimal typed event bus. Handlers run synchronously in subscription order. */
export class EventBus {
  private handlers = new Map<SimEventName, Set<Handler<SimEventName>>>();

  on<K extends SimEventName>(name: K, handler: Handler<K>): () => void {
    let set = this.handlers.get(name);
    if (!set) { set = new Set(); this.handlers.set(name, set); }
    set.add(handler as Handler<SimEventName>);
    return () => this.off(name, handler);
  }

  once<K extends SimEventName>(name: K, handler: Handler<K>): () => void {
    const off = this.on(name, (p) => { off(); handler(p); });
    return off;
  }

  off<K extends SimEventName>(name: K, handler: Handler<K>): void {
    this.handlers.get(name)?.delete(handler as Handler<SimEventName>);
  }

  emit<K extends SimEventName>(name: K, payload: SimEvents[K]): void {
    const set = this.handlers.get(name);
    if (!set) return;
    for (const h of Array.from(set)) {
      try { (h as Handler<K>)(payload); } catch (e) { console.error(`[events] handler for ${name} threw`, e); }
    }
  }

  clear(): void { this.handlers.clear(); }
}
