export type StorageKind = 'localStorage' | 'sessionStorage';

export interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

const PROBE_KEY = '__argos_probe__';

/** Private mode and blocked cookies throw on access *or* on write, so probe both. */
function probe(kind: StorageKind): Storage | null {
  try {
    const backing = globalThis[kind];
    backing.setItem(PROBE_KEY, '1');
    backing.removeItem(PROBE_KEY);
    return backing;
  } catch {
    return null;
  }
}

export function createStore(kind: StorageKind): KeyValueStore {
  const memory = new Map<string, string>();
  const backing = probe(kind);
  return {
    get(key) {
      try {
        return backing?.getItem(key) ?? memory.get(key) ?? null;
      } catch {
        return memory.get(key) ?? null;
      }
    },
    set(key, value) {
      memory.set(key, value);
      try {
        backing?.setItem(key, value);
      } catch {
        // Quota exceeded mid-session: memory already holds it, degrade quietly.
      }
    },
    remove(key) {
      memory.delete(key);
      try {
        backing?.removeItem(key);
      } catch {
        // Same as `set`: the in-memory copy is already gone, which is what
        // this tab will read for the rest of its life.
      }
    },
  };
}

export function memoryStore(): KeyValueStore {
  const memory = new Map<string, string>();
  return {
    get: (key) => memory.get(key) ?? null,
    set: (key, value) => void memory.set(key, value),
    remove: (key) => {
      memory.delete(key);
    },
  };
}
