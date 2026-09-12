/**
 * Local Database Engine for FileGuard (IndexedDB with LocalStorage Fallback)
 * Directly handles client-side persistent storage for scans, history, and user settings.
 */

import { ScanResultData, UndoHistoryRecord } from './types';

const DB_NAME = 'FileGuardLocalDB';
const DB_VERSION = 1;

let dbInstance: IDBDatabase | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbInstance) {
    return Promise.resolve(dbInstance);
  }

  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      return reject(new Error('IndexedDB not supported in this environment'));
    }

    const request = window.indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      
      if (!db.objectStoreNames.contains('scans')) {
        db.createObjectStore('scans', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('history')) {
        db.createObjectStore('history', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
    };

    request.onsuccess = (event) => {
      dbInstance = (event.target as IDBOpenDBRequest).result;
      resolve(dbInstance);
    };

    request.onerror = (event) => {
      console.warn('Failed to open IndexedDB, fallback will be used', event);
      reject((event.target as IDBOpenDBRequest).error);
    };
  });
}

// ----------------- Scans Store -----------------
export async function saveScanToLocalDB(scan: ScanResultData): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction('scans', 'readwrite');
    const store = tx.objectStore('scans');
    const record = {
      ...scan,
      id: scan.id || `scan_${Date.now()}`
    };
    store.put(record);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    try {
      localStorage.setItem('fileguard_latest_scan', JSON.stringify(scan));
    } catch (e) {
      console.error('Local storage fallback error:', e);
    }
  }
}

export async function getLatestScanFromLocalDB(): Promise<ScanResultData | null> {
  try {
    const db = await openDB();
    const tx = db.transaction('scans', 'readonly');
    const store = tx.objectStore('scans');
    const request = store.getAll();

    return new Promise((resolve) => {
      request.onsuccess = () => {
        const results = request.result as ScanResultData[];
        if (results && results.length > 0) {
          // Sort by timestamp descending
          results.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
          resolve(results[0]);
        } else {
          resolve(null);
        }
      };
      request.onerror = () => resolve(null);
    });
  } catch {
    const fallback = localStorage.getItem('fileguard_latest_scan');
    if (fallback) {
      try {
        return JSON.parse(fallback);
      } catch {
        return null;
      }
    }
    return null;
  }
}

// ----------------- History Store -----------------
export async function saveHistoryToLocalDB(item: UndoHistoryRecord): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction('history', 'readwrite');
    const store = tx.objectStore('history');
    store.put(item);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    try {
      localStorage.setItem('fileguard_latest_history', JSON.stringify(item));
    } catch (e) {
      console.error('Local storage fallback error:', e);
    }
  }
}

export async function getLatestHistoryFromLocalDB(): Promise<UndoHistoryRecord | null> {
  try {
    const db = await openDB();
    const tx = db.transaction('history', 'readonly');
    const store = tx.objectStore('history');
    const request = store.getAll();

    return new Promise((resolve) => {
      request.onsuccess = () => {
        const results = request.result as UndoHistoryRecord[];
        if (results && results.length > 0) {
          results.sort((a, b) => b.id.localeCompare(a.id));
          resolve(results[0]);
        } else {
          resolve(null);
        }
      };
      request.onerror = () => resolve(null);
    });
  } catch {
    const fallback = localStorage.getItem('fileguard_latest_history');
    if (fallback) {
      try {
        return JSON.parse(fallback);
      } catch {
        return null;
      }
    }
    return null;
  }
}

export async function updateHistoryInLocalDB(item: UndoHistoryRecord): Promise<void> {
  await saveHistoryToLocalDB(item);
}

// ----------------- Settings Store -----------------
export async function saveSettingToLocalDB<T>(key: string, value: T): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction('settings', 'readwrite');
    const store = tx.objectStore('settings');
    store.put({ key, value });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    try {
      localStorage.setItem(`fileguard_setting_${key}`, JSON.stringify(value));
    } catch (e) {
      console.error('Setting fallback error:', e);
    }
  }
}

export async function getSettingFromLocalDB<T>(key: string, defaultValue: T): Promise<T> {
  try {
    const db = await openDB();
    const tx = db.transaction('settings', 'readonly');
    const store = tx.objectStore('settings');
    const request = store.get(key);

    return new Promise((resolve) => {
      request.onsuccess = () => {
        if (request.result && request.result.value !== undefined) {
          resolve(request.result.value as T);
        } else {
          resolve(defaultValue);
        }
      };
      request.onerror = () => resolve(defaultValue);
    });
  } catch {
    const fallback = localStorage.getItem(`fileguard_setting_${key}`);
    if (fallback) {
      try {
        return JSON.parse(fallback) as T;
      } catch {
        return defaultValue;
      }
    }
    return defaultValue;
  }
}
