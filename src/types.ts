export type Language = 'ar' | 'en';

export type NavTab = 'home' | 'scan' | 'issues' | 'reports' | 'more';

export interface FileItem {
  id: string;
  name: string;
  path: string;
  sizeBytes: number;
  sizeFormatted: string;
  badge?: 'recommended' | 'original' | 'duplicate';
  checked?: boolean;
}

export interface FileGroup {
  id: string;
  titleAr: string;
  titleEn: string;
  size: string;
  items: FileItem[];
}

export interface ScanStats {
  scanned: number;
  issues: number;
  recoverable: string;
}

export interface FileDistribution {
  media: string;
  docs: string;
  archives: string;
}

export interface UndoHistoryRecord {
  id: string;
  count: number;
  size: string;
  timestamp: string;
  active: boolean;
  fileIds?: string[];
}

export interface ScanResultData {
  id?: string;
  folder: string;
  timestamp: string;
  stats: ScanStats;
  distribution: FileDistribution;
  groups: FileGroup[];
}

export interface ScanOptions {
  duplicates: boolean;
  largeFiles: boolean;
  oldFiles: boolean;
  sensitiveFiles: boolean;
}

export interface AppStateData {
  stats: ScanStats;
  distribution: FileDistribution;
  groups: FileGroup[];
  undoHistory: UndoHistoryRecord | null;
}

// Global window declaration for Python backend bridge (PyWebView / Electron / Desktop)
declare global {
  interface Window {
    pywebview?: {
      api?: {
        selectFolder?: () => Promise<string | null>;
        startScan?: (folder: string, options: ScanOptions) => Promise<ScanResultData>;
        moveToTrash?: (filePaths: string[]) => Promise<boolean>;
        undoTrash?: (historyId: string) => Promise<boolean>;
      };
    };
  }
}
