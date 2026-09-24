// Node 26 owns a `localStorage` global that stays undefined without
// --localstorage-file, and it shadows the one happy-dom installs. Put a real
// Storage back so the storage tests exercise the browser path.
class MemoryStorage implements Storage {
  private readonly entries = new Map<string, string>();

  get length(): number {
    return this.entries.size;
  }

  key(index: number): string | null {
    return [...this.entries.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.entries.set(key, value);
  }

  removeItem(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}

for (const name of ['localStorage', 'sessionStorage'] as const) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value: new MemoryStorage(),
  });
}

// No test may reach the network: a heartbeat timer firing after a test's own
// fetch stub was restored would otherwise resolve a real hostname.
globalThis.fetch = () => Promise.reject(new TypeError('network disabled in tests'));
