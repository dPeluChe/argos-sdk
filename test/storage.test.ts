import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore, memoryStore } from '../src/storage.js';

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('createStore', () => {
  it('reads and writes through the real backing store', () => {
    const store = createStore('localStorage');
    store.set('k', 'v');
    expect(localStorage.getItem('k')).toBe('v');
    expect(store.get('k')).toBe('v');
  });

  it('returns null for a missing key', () => {
    expect(createStore('localStorage').get('absent')).toBeNull();
  });

  it('falls back to memory when the storage object is missing', () => {
    vi.stubGlobal('localStorage', undefined);
    const store = createStore('localStorage');
    store.set('k', 'v');
    expect(store.get('k')).toBe('v');
  });

  it('falls back to memory when setItem throws (private mode)', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('QuotaExceededError');
      },
      removeItem: () => undefined,
    });
    const store = createStore('localStorage');
    store.set('k', 'v');
    expect(store.get('k')).toBe('v');
  });

  it('falls back to memory when reading the storage object throws', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('blocked by cookie policy');
      },
    });
    try {
      const store = createStore('localStorage');
      store.set('k', 'v');
      expect(store.get('k')).toBe('v');
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
    }
  });

  it('survives a backing store that throws on read after the probe passed', () => {
    let armed = false;
    vi.stubGlobal('localStorage', {
      getItem: () => {
        if (armed) throw new Error('gone');
        return null;
      },
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    const store = createStore('localStorage');
    store.set('k', 'v');
    armed = true;
    expect(store.get('k')).toBe('v');
  });
});

describe('memoryStore', () => {
  it('keeps values without touching the DOM', () => {
    const store = memoryStore();
    expect(store.get('k')).toBeNull();
    store.set('k', 'v');
    expect(store.get('k')).toBe('v');
  });
});
