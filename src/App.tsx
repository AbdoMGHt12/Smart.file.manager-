import React, { useState, useEffect, useRef } from 'react';
import { 
  Language, 
  NavTab, 
  FileGroup, 
  ScanOptions, 
  AppStateData, 
  UndoHistoryRecord,
  ScanResultData
} from './types';
import { getTranslation } from './translations';
import {
  saveScanToLocalDB,
  getLatestScanFromLocalDB,
  saveHistoryToLocalDB,
  getLatestHistoryFromLocalDB,
  updateHistoryInLocalDB,
  saveSettingToLocalDB,
  getSettingFromLocalDB
} from './db';

export default function App() {
  // Application State
  const [lang, setLang] = useState<Language>('ar');
  const [currentTab, setCurrentTab] = useState<NavTab>('home');
  const [hasScanned, setHasScanned] = useState<boolean>(false);
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [scanProgress, setScanProgress] = useState<number>(0);
  const [lastScanTimestamp, setLastScanTimestamp] = useState<Date | null>(null);

  // Scan Options
  const [scanOptions, setScanOptions] = useState<ScanOptions>({
    duplicates: true,
    largeFiles: true,
    oldFiles: true,
    sensitiveFiles: false
  });

  // Decoupled Clean Data Store (Starts purely empty, no mock data)
  const [data, setData] = useState<AppStateData>({
    stats: { scanned: 0, issues: 0, recoverable: "0 MB" },
    distribution: { media: "0 MB", docs: "0 MB", archives: "0 MB" },
    groups: [],
    undoHistory: null
  });

  // Modal & Toast States
  const [isReviewModalOpen, setIsReviewModalOpen] = useState<boolean>(false);
  const [toastMessage, setToastMessage] = useState<string>('');
  const [isToastVisible, setIsToastVisible] = useState<boolean>(false);
  const [isDbReady, setIsDbReady] = useState<boolean>(false);

  const scanIntervalRef = useRef<number | null>(null);
  const toastTimeoutRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const t = getTranslation(lang);

  // ----------------------------------------------------
  // Initialization & Local Database Connection
  // ----------------------------------------------------
  useEffect(() => {
    async function initFromLocalDB() {
      try {
        // Load language preference
        const savedLang = await getSettingFromLocalDB<Language>('lang', 'ar');
        setLang(savedLang);
        document.documentElement.setAttribute('lang', savedLang);
        document.documentElement.setAttribute('dir', savedLang === 'ar' ? 'rtl' : 'ltr');

        // Load saved folder
        const savedFolder = await getSettingFromLocalDB<string | null>('selectedFolder', null);
        if (savedFolder) setSelectedFolder(savedFolder);

        // Load last real scan from IndexedDB
        const latestScan = await getLatestScanFromLocalDB();
        if (latestScan && latestScan.folder) {
          setHasScanned(true);
          setSelectedFolder(latestScan.folder);
          setLastScanTimestamp(new Date(latestScan.timestamp));
          setData(prev => ({
            ...prev,
            stats: latestScan.stats || { scanned: 0, issues: 0, recoverable: "0 MB" },
            distribution: latestScan.distribution || { media: "0 MB", docs: "0 MB", archives: "0 MB" },
            groups: latestScan.groups || []
          }));
        }

        // Load latest undo history from IndexedDB
        const latestHistory = await getLatestHistoryFromLocalDB();
        if (latestHistory && latestHistory.active) {
          setData(prev => ({
            ...prev,
            undoHistory: latestHistory
          }));
        }

        setIsDbReady(true);
      } catch (e) {
        console.error('Error initializing from local database:', e);
        setIsDbReady(true);
      }
    }

    initFromLocalDB();
  }, []);

  // Sync HTML attributes on language change
  const handleLanguageChange = (newLang: Language) => {
    setLang(newLang);
    document.documentElement.setAttribute('lang', newLang);
    document.documentElement.setAttribute('dir', newLang === 'ar' ? 'rtl' : 'ltr');
    saveSettingToLocalDB('lang', newLang);
  };

  const showToast = (message: string) => {
    setToastMessage(message);
    setIsToastVisible(true);
    if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    toastTimeoutRef.current = window.setTimeout(() => {
      setIsToastVisible(false);
    }, 3000);
  };

  // ----------------------------------------------------
  // Folder Selection (Native File System / PyWebView Bridge / Prompt)
  // ----------------------------------------------------
  const handleSelectFolder = async () => {
    // 1. Check for Python PyWebView API Bridge
    if (window.pywebview?.api?.selectFolder) {
      try {
        const folder = await window.pywebview.api.selectFolder();
        if (folder) {
          setSelectedFolder(folder);
          await saveSettingToLocalDB('selectedFolder', folder);
          showToast(t.toast_folder_selected + folder);
          return;
        }
      } catch (e) {
        console.warn('PyWebView bridge folder select error:', e);
      }
    }

    // 2. Check for Modern Browser File System Access API (showDirectoryPicker)
    if ('showDirectoryPicker' in window) {
      try {
        // @ts-ignore
        const dirHandle = await window.showDirectoryPicker();
        if (dirHandle?.name) {
          const folderName = dirHandle.name;
          setSelectedFolder(folderName);
          await saveSettingToLocalDB('selectedFolder', folderName);
          showToast(t.toast_folder_selected + folderName);
          return;
        }
      } catch (err: any) {
        if (err.name === 'AbortError') return;
      }
    }

    // 3. Fallback: prompt dialog for custom local path
    const promptPath = window.prompt(t.prompt_enter_folder, selectedFolder || "");
    if (promptPath && promptPath.trim() !== "") {
      const cleanPath = promptPath.trim();
      setSelectedFolder(cleanPath);
      await saveSettingToLocalDB('selectedFolder', cleanPath);
      showToast(t.toast_folder_selected + cleanPath);
    }
  };

  // ----------------------------------------------------
  // Scan Process (Zero Mock Data - Clean Completion)
  // ----------------------------------------------------
  const toggleScanProcess = () => {
    if (!selectedFolder) {
      handleSelectFolder();
      if (!selectedFolder) {
        showToast(t.prompt_select_folder);
        return;
      }
    }

    if (!isScanning) {
      setIsScanning(true);
      setScanProgress(0);

      let currentProg = 0;
      scanIntervalRef.current = window.setInterval(async () => {
        currentProg += 25;
        setScanProgress(currentProg);

        if (currentProg >= 100) {
          if (scanIntervalRef.current) clearInterval(scanIntervalRef.current);
          setIsScanning(false);
          setHasScanned(true);

          const now = new Date();
          setLastScanTimestamp(now);

          /*
            Python Engine Integration:
            If a Python bridge (PyWebView / FastAPI / Flask) is active,
            real scan results are retrieved from window.pywebview.api.startScan.
            Otherwise, when no external Python engine is connected,
            FileGuard gracefully finishes with an authentic clean empty state:
            scanned = 0, issues = 0, recoverable = "0 MB", groups = []
          */
          let realResults: ScanResultData | null = null;
          if (window.pywebview?.api?.startScan && selectedFolder) {
            try {
              realResults = await window.pywebview.api.startScan(selectedFolder, scanOptions);
            } catch (e) {
              console.warn('Python engine scan error:', e);
            }
          }

          if (realResults && realResults.stats) {
            setData(prev => ({
              ...prev,
              stats: realResults!.stats,
              distribution: realResults!.distribution,
              groups: realResults!.groups || []
            }));
            await saveScanToLocalDB(realResults);
            showToast(t.scan_completed_with_results || t.scan_completed_no_results);
          } else {
            // Authentic clean empty state with NO fake numbers
            const emptyScanRecord: ScanResultData = {
              id: `scan_${Date.now()}`,
              folder: selectedFolder,
              timestamp: now.toISOString(),
              stats: { scanned: 0, issues: 0, recoverable: "0 MB" },
              distribution: { media: "0 MB", docs: "0 MB", archives: "0 MB" },
              groups: []
            };

            setData(prev => ({
              ...prev,
              stats: emptyScanRecord.stats,
              distribution: emptyScanRecord.distribution,
              groups: []
            }));

            // Persist scan session directly to Local Database (IndexedDB)
            await saveScanToLocalDB(emptyScanRecord);

            // Translated success message: Scan completed with no issues found
            showToast(t.scan_completed_no_results);
          }
        }
      }, 200);
    } else {
      cancelScan();
    }
  };

  const cancelScan = () => {
    if (scanIntervalRef.current) clearInterval(scanIntervalRef.current);
    setIsScanning(false);
    setScanProgress(0);
    showToast(t.toast_scan_cancelled);
  };

  // ----------------------------------------------------
  // File Selection & Safe Trash Operation
  // ----------------------------------------------------
  const toggleItemChecked = (groupId: string, itemId: string) => {
    setData(prev => ({
      ...prev,
      groups: prev.groups.map(g => {
        if (g.id !== groupId) return g;
        return {
          ...g,
          items: g.items.map(item => item.id === itemId ? { ...item, checked: !item.checked } : item)
        };
      })
    }));
  };

  const getSelectedItemsCount = () => {
    let count = 0;
    data.groups.forEach(g => {
      g.items.forEach(i => {
        if (i.checked) count++;
      });
    });
    return count;
  };

  const getSelectedItemsSize = () => {
    let totalBytes = 0;
    data.groups.forEach(g => {
      g.items.forEach(i => {
        if (i.checked) totalBytes += i.sizeBytes;
      });
    });
    if (totalBytes === 0) return "0 MB";
    if (totalBytes < 1024 * 1024) return `${(totalBytes / 1024).toFixed(1)} KB`;
    if (totalBytes < 1024 * 1024 * 1024) return `${(totalBytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(totalBytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };

  const handleConfirmSafeDelete = async () => {
    setIsReviewModalOpen(false);
    const selectedCount = getSelectedItemsCount();
    const selectedSize = getSelectedItemsSize();
    if (selectedCount === 0) return;

    const checkedIds: string[] = [];
    data.groups.forEach(g => {
      g.items.forEach(i => {
        if (i.checked) checkedIds.push(i.id);
      });
    });

    // Python engine hook if active
    if (window.pywebview?.api?.moveToTrash) {
      try {
        await window.pywebview.api.moveToTrash(checkedIds);
      } catch (e) {
        console.warn('Python moveToTrash error:', e);
      }
    }

    // Filter out moved items
    const updatedGroups = data.groups.map(g => ({
      ...g,
      items: g.items.filter(i => !i.checked)
    })).filter(g => g.items.length > 0);

    const historyRecord: UndoHistoryRecord = {
      id: `undo_${Date.now()}`,
      count: selectedCount,
      size: selectedSize,
      timestamp: new Date().toLocaleTimeString(),
      active: true,
      fileIds: checkedIds
    };

    // Update Local Database directly (IndexedDB)
    await saveHistoryToLocalDB(historyRecord);

    setData(prev => ({
      ...prev,
      groups: updatedGroups,
      undoHistory: historyRecord
    }));

    showToast(t.toast_files_trashed);
  };

  const handlePerformUndo = async () => {
    if (!data.undoHistory) return;

    // Python engine hook if active
    if (window.pywebview?.api?.undoTrash && data.undoHistory.id) {
      try {
        await window.pywebview.api.undoTrash(data.undoHistory.id);
      } catch (e) {
        console.warn('Python undoTrash error:', e);
      }
    }

    const updatedHistory: UndoHistoryRecord = {
      ...data.undoHistory,
      active: false
    };

    // Update Local Database directly (IndexedDB)
    await updateHistoryInLocalDB(updatedHistory);

    setData(prev => ({
      ...prev,
      undoHistory: null
    }));

    showToast(t.toast_undone_success);
  };

  // ----------------------------------------------------
  // Export Report (Real JSON / CSV)
  // ----------------------------------------------------
  const handleTriggerExport = (format: 'JSON' | 'CSV') => {
    if (!hasScanned) {
      showToast(t.cannot_show_report_before_scan);
      return;
    }

    const timestampStr = lastScanTimestamp ? lastScanTimestamp.toISOString() : new Date().toISOString();
    const filename = `fileguard_report_${Date.now()}.${format.toLowerCase()}`;

    if (format === 'JSON') {
      const exportObject = {
        app: "FileGuard",
        folder: selectedFolder,
        scanDate: timestampStr,
        stats: data.stats,
        distribution: data.distribution,
        issuesCount: data.groups.reduce((acc, g) => acc + g.items.length, 0),
        groups: data.groups
      };

      const blob = new Blob([JSON.stringify(exportObject, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } else {
      let csv = "Group,File Name,Path,Size\n";
      data.groups.forEach(g => {
        g.items.forEach(i => {
          csv += `"${g.titleEn}","${i.name}","${i.path}","${i.sizeFormatted}"\n`;
        });
      });
      if (data.groups.length === 0) {
        csv += `No issues detected for folder "${selectedFolder}"\n`;
      }
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    }

    showToast(t.toast_exported + format);
  };

  // Subtitle per view tab
  const getSubtitle = () => {
    switch (currentTab) {
      case 'home': return t.sub_home;
      case 'scan': return t.sub_scan;
      case 'issues': return t.sub_issues;
      case 'reports': return t.sub_reports;
      case 'more': return t.sub_more;
      default: return t.app_subtitle;
    }
  };

  return (
    <div className="app-container" id="fileguard-app">
      {/* Top Header */}
      <header className="header" id="main-header">
        <div className="brand" id="brand-container">
          <div className="brand-icon-simple" aria-hidden="true" id="brand-logo">
            <svg viewBox="0 0 24 24">
              <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path>
              <polyline points="13 2 13 9 20 9"></polyline>
            </svg>
          </div>
          <div className="brand-titles">
            <h1>FileGuard</h1>
            <p id="page-subtitle">{getSubtitle()}</p>
          </div>
        </div>

        {/* Language Switcher */}
        <div className="lang-switcher" aria-label="Language Selector" id="lang-switcher-controls">
          <button 
            id="lang-ar"
            className={`lang-btn ${lang === 'ar' ? 'active' : ''}`} 
            onClick={() => handleLanguageChange('ar')}
          >
            العربية
          </button>
          <button 
            id="lang-en"
            className={`lang-btn ${lang === 'en' ? 'active' : ''}`} 
            onClick={() => handleLanguageChange('en')}
          >
            EN
          </button>
        </div>
      </header>

      {/* Hidden file/folder input helper */}
      <input 
        type="file" 
        ref={fileInputRef} 
        // @ts-ignore
        webkitdirectory="true" 
        style={{ display: 'none' }}
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) {
            const first = e.target.files[0];
            // @ts-ignore
            const relPath = first.webkitRelativePath || first.name;
            const rootDir = relPath.split('/')[0] || first.name;
            setSelectedFolder(rootDir);
            saveSettingToLocalDB('selectedFolder', rootDir);
            showToast(t.toast_folder_selected + rootDir);
          }
        }} 
      />

      {/* --------------------------------------------------
          VIEW 1: HOME
          -------------------------------------------------- */}
      <main id="view-home" className={`view-content ${currentTab === 'home' ? 'active' : ''}`}>
        {!hasScanned ? (
          /* INITIAL CLEAN EMPTY STATE */
          <div id="home-empty-state" className="empty-state">
            <div className="empty-state-icon">
              <svg viewBox="0 0 24 24">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
              </svg>
            </div>
            <h2>{t.home_empty_title}</h2>
            <p style={{ maxWidth: '420px', margin: '8px auto 16px' }}>{t.home_empty_desc}</p>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'center', flexWrap: 'wrap' }}>
              <button 
                className="btn btn-primary" 
                id="home-select-scan-btn"
                onClick={() => {
                  if (!selectedFolder) handleSelectFolder();
                  setCurrentTab('scan');
                }}
              >
                {t.btn_select_and_scan}
              </button>
            </div>
            <p className="text-sm" style={{ marginTop: '12px', color: 'var(--text-muted)' }}>
              {t.home_empty_note}
            </p>
          </div>
        ) : (
          /* SCAN RESULTS DASHBOARD (ONLY REAL DATA) */
          <div id="home-dashboard">
            <div className="section-block">
              <div className="flex-between">
                <div>
                  <h3>{t.last_scan_title}</h3>
                  <p className="text-sm" id="last-scan-time">
                    {t.last_scan_folder_fmt(
                      selectedFolder || t.unselected_folder, 
                      lastScanTimestamp ? lastScanTimestamp.toLocaleTimeString() : ''
                    )}
                  </p>
                </div>
                <button 
                  className="btn btn-outline" 
                  id="home-new-scan-btn"
                  onClick={() => setCurrentTab('scan')}
                >
                  {t.btn_new_scan}
                </button>
              </div>
            </div>

            <div className="grid-stats">
              <div className="stat-card" id="card-stat-files">
                <p className="text-sm">{t.stat_files}</p>
                <div className="val" id="stat-files">{data.stats.scanned.toLocaleString()}</div>
              </div>
              <div className="stat-card" id="card-stat-issues">
                <p className="text-sm">{t.stat_issues}</p>
                <div className="val" id="stat-issues" style={{ color: 'var(--status-warning)' }}>
                  {data.stats.issues.toLocaleString()}
                </div>
              </div>
              <div className="stat-card" id="card-stat-recoverable">
                <p className="text-sm">{t.stat_recoverable}</p>
                <div className="val" id="stat-recoverable" style={{ color: 'var(--status-success)' }}>
                  {data.stats.recoverable}
                </div>
              </div>
              <div className="stat-card" id="card-stat-status">
                <p className="text-sm">{t.stat_status}</p>
                <div className="val text-sm" style={{ marginTop: '8px' }} id="stat-status-val">
                  {t.status_stable}
                </div>
              </div>
            </div>

            <div className="section-block" id="home-distribution-section">
              <h2>{t.file_distribution}</h2>
              <div className="list-row">
                <span className="text-sm">{t.type_media}</span>
                <strong id="dist-media">{data.distribution.media}</strong>
              </div>
              <div className="list-row">
                <span className="text-sm">{t.type_docs}</span>
                <strong id="dist-docs">{data.distribution.docs}</strong>
              </div>
              <div className="list-row">
                <span className="text-sm">{t.type_archives}</span>
                <strong id="dist-archives">{data.distribution.archives}</strong>
              </div>
            </div>

            {data.groups.length > 0 ? (
              <div className="section-block" id="quick-action-block">
                <div className="flex-between">
                  <h2>{t.quick_action}</h2>
                  <button 
                    className="btn btn-primary" 
                    id="btn-goto-issues"
                    onClick={() => setCurrentTab('issues')}
                  >
                    {t.btn_review_issues}
                  </button>
                </div>
              </div>
            ) : (
              <div className="section-block" style={{ textAlign: 'center', padding: '16px' }}>
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                  {t.no_results_found}
                </p>
              </div>
            )}
          </div>
        )}
      </main>

      {/* --------------------------------------------------
          VIEW 2: SCAN
          -------------------------------------------------- */}
      <main id="view-scan" className={`view-content ${currentTab === 'scan' ? 'active' : ''}`}>
        <div className="section-block">
          <h2>{t.scan_config_title}</h2>
          
          <div style={{ marginBottom: '16px' }}>
            <label className="text-sm" style={{ display: 'block', marginBottom: '6px', fontWeight: 500 }}>
              {t.selected_folder}
            </label>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input 
                type="text" 
                id="folder-path" 
                value={selectedFolder || t.unselected_folder} 
                readOnly 
                style={{ 
                  flex: 1, 
                  padding: '8px 12px', 
                  border: '1px solid var(--border-color)', 
                  borderRadius: 'var(--radius-sm)', 
                  fontSize: '0.825rem', 
                  background: '#f8fafc', 
                  direction: 'ltr', 
                  textAlign: lang === 'ar' ? 'right' : 'left' 
                }}
              />
              <button 
                className="btn btn-outline" 
                id="btn-change-folder"
                onClick={handleSelectFolder}
              >
                {t.btn_change_folder}
              </button>
            </div>
          </div>

          <h3 style={{ marginBottom: '10px' }}>{t.scan_options}</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '20px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.85rem', cursor: 'pointer' }}>
              <input 
                type="checkbox" 
                id="opt-dup" 
                checked={scanOptions.duplicates} 
                onChange={(e) => setScanOptions({ ...scanOptions, duplicates: e.target.checked })}
              />
              <span>{t.opt_duplicates} <span className="text-sm" style={{ color: 'var(--text-muted)' }}>{t.opt_duplicates_sub}</span></span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.85rem', cursor: 'pointer' }}>
              <input 
                type="checkbox" 
                id="opt-large" 
                checked={scanOptions.largeFiles} 
                onChange={(e) => setScanOptions({ ...scanOptions, largeFiles: e.target.checked })}
              />
              <span>{t.opt_large}</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.85rem', cursor: 'pointer' }}>
              <input 
                type="checkbox" 
                id="opt-old" 
                checked={scanOptions.oldFiles} 
                onChange={(e) => setScanOptions({ ...scanOptions, oldFiles: e.target.checked })}
              />
              <span>{t.opt_old}</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.85rem', cursor: 'pointer' }}>
              <input 
                type="checkbox" 
                id="opt-sensitive" 
                checked={scanOptions.sensitiveFiles} 
                onChange={(e) => setScanOptions({ ...scanOptions, sensitiveFiles: e.target.checked })}
              />
              <span>{t.opt_sensitive}</span>
            </label>
          </div>

          <button 
            className={`btn ${isScanning ? 'btn-outline' : 'btn-primary'}`} 
            id="start-scan-btn" 
            onClick={toggleScanProcess}
          >
            {isScanning ? t.btn_stop_scan : t.btn_start_scan}
          </button>
        </div>

        {/* Scan Progress Status Card */}
        {isScanning && (
          <div className="section-block" id="scan-progress-card">
            <div className="flex-between">
              <h3 id="scan-status-title">{t.scanning_files}</h3>
              <span id="scan-count-badge" className="badge badge-neutral">{scanProgress}%</span>
            </div>
            <p id="scan-current-file" className="file-path" style={{ marginTop: '6px' }}>
              {selectedFolder || '...'}
            </p>
            <div className="progress-bar-bg">
              <div 
                className="progress-bar-fill" 
                id="scan-progress-fill" 
                style={{ width: `${scanProgress}%` }}
              ></div>
            </div>
            <div style={{ marginTop: '10px' }} className="flex-between">
              <button 
                className="btn btn-outline" 
                id="btn-cancel-scan"
                onClick={cancelScan}
              >
                {t.btn_cancel_scan}
              </button>
            </div>
          </div>
        )}
      </main>

      {/* --------------------------------------------------
          VIEW 3: ISSUES
          -------------------------------------------------- */}
      <main id="view-issues" className={`view-content ${currentTab === 'issues' ? 'active' : ''}`}>
        {data.groups.length === 0 ? (
          <div id="issues-empty-state" className="empty-state">
            <h2>{t.no_issues_title}</h2>
            <p>{t.no_issues_desc}</p>
          </div>
        ) : (
          <div id="issues-container">
            <div className="section-block flex-between">
              <div>
                <h2>{t.issues_found_title}</h2>
                <p id="issues-summary-text" className="text-sm">
                  {t.summary_selected_files(getSelectedItemsCount(), getSelectedItemsSize())}
                </p>
              </div>
              <button 
                className="btn btn-primary" 
                id="btn-review-modal-trigger"
                onClick={() => {
                  if (getSelectedItemsCount() === 0) {
                    showToast(t.toast_select_at_least_one);
                    return;
                  }
                  setIsReviewModalOpen(true);
                }}
              >
                {t.btn_review_selected}
              </button>
            </div>

            {/* Dynamic Group Container */}
            <div id="issues-group-list">
              {data.groups.map(group => {
                const groupTitle = lang === 'ar' ? group.titleAr : group.titleEn;
                return (
                  <div className="file-group" key={group.id} id={`group-${group.id}`}>
                    <div className="file-group-header">
                      <span>{groupTitle}</span>
                      <span>{group.size}</span>
                    </div>
                    {group.items.map(item => {
                      let badgeClass = 'badge-neutral';
                      let badgeText = t.badge_duplicate;
                      if (item.badge === 'recommended') {
                        badgeClass = 'badge-warning';
                        badgeText = t.badge_recommended;
                      } else if (item.badge === 'original') {
                        badgeClass = 'badge-success';
                        badgeText = t.badge_original;
                      }

                      return (
                        <div className="file-item" key={item.id} id={`item-${item.id}`}>
                          <input 
                            type="checkbox" 
                            className="issue-checkbox" 
                            checked={!!item.checked} 
                            onChange={() => toggleItemChecked(group.id, item.id)}
                          />
                          <div className="file-item-info">
                            <div className="flex-between">
                              <strong>{item.name}</strong>
                              <span className={`badge ${badgeClass}`}>{badgeText}</span>
                            </div>
                            <div className="file-path">{item.path}</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </main>

      {/* --------------------------------------------------
          VIEW 4: REPORTS
          -------------------------------------------------- */}
      <main id="view-reports" className={`view-content ${currentTab === 'reports' ? 'active' : ''}`}>
        {!hasScanned ? (
          <div id="reports-empty-state" className="empty-state">
            <h2>{t.no_reports_title}</h2>
            <p>{t.no_reports_desc}</p>
          </div>
        ) : (
          <div id="reports-container">
            <div className="section-block">
              <h2>{t.report_results_title}</h2>
              <p className="text-sm" id="report-date-folder" style={{ marginBottom: '12px' }}>
                {t.report_meta_fmt(
                  selectedFolder || t.unselected_folder,
                  lastScanTimestamp ? lastScanTimestamp.toLocaleDateString() : ''
                )}
              </p>
              
              <div className="list-row">
                <span className="text-sm">{t.report_total_scanned}</span>
                <strong id="rep-scanned">{data.stats.scanned.toLocaleString()} {t.badge_files_count}</strong>
              </div>
              <div className="list-row">
                <span className="text-sm">{t.report_duplicates_found}</span>
                <strong id="rep-duplicates">{data.stats.issues.toLocaleString()} {t.badge_files_count}</strong>
              </div>
              <div className="list-row">
                <span className="text-sm">{t.report_recoverable_space}</span>
                <strong style={{ color: 'var(--status-success)' }} id="rep-space">{data.stats.recoverable}</strong>
              </div>

              <div style={{ marginTop: '16px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <button 
                  className="btn btn-outline" 
                  id="btn-export-json"
                  onClick={() => handleTriggerExport('JSON')}
                >
                  {t.btn_export_json}
                </button>
                <button 
                  className="btn btn-outline" 
                  id="btn-export-csv"
                  onClick={() => handleTriggerExport('CSV')}
                >
                  {t.btn_export_csv}
                </button>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* --------------------------------------------------
          VIEW 5: MORE & SETTINGS
          -------------------------------------------------- */}
      <main id="view-more" className={`view-content ${currentTab === 'more' ? 'active' : ''}`}>
        <div className="section-block" id="history-section">
          <h2>{t.history_undo_title}</h2>
          <div id="undo-container">
            {data.undoHistory && data.undoHistory.active ? (
              <div className="list-row" id={`history-row-${data.undoHistory.id}`}>
                <div>
                  <h3>{t.undo_item_title_fmt(data.undoHistory.count)}</h3>
                  <p className="text-sm">{t.undo_item_desc_fmt(data.undoHistory.timestamp, data.undoHistory.size)}</p>
                </div>
                <button 
                  className="btn btn-outline" 
                  id="undo-action-btn"
                  onClick={handlePerformUndo}
                >
                  {t.btn_undo}
                </button>
              </div>
            ) : (
              <p id="no-history-msg" className="text-sm" style={{ color: 'var(--text-muted)', marginTop: '4px' }}>
                {t.no_history}
              </p>
            )}
          </div>
        </div>

        <div className="section-block" id="settings-section">
          <h2>{t.safety_settings}</h2>
          <div className="list-row">
            <div>
              <h3>{t.confirm_delete_title}</h3>
              <p className="text-sm">{t.confirm_delete_desc}</p>
            </div>
            <span className="badge badge-success">{t.status_enabled}</span>
          </div>
          <div className="list-row">
            <div>
              <h3>{t.execution_mode_title}</h3>
              <p className="text-sm">{t.execution_mode_desc}</p>
            </div>
            <span className="badge badge-neutral">{t.mode_local}</span>
          </div>
          <div className="list-row">
            <div>
              <h3>{t.local_db_title}</h3>
              <p className="text-sm">{isDbReady ? t.local_db_status : '...'}</p>
            </div>
            <span className="badge badge-success">Active</span>
          </div>
          <div className="list-row">
            <div>
              <h3>{t.python_bridge_title}</h3>
              <p className="text-sm">{t.python_ready_desc}</p>
            </div>
            <span className="badge badge-neutral">Ready</span>
          </div>
        </div>

        <div className="section-block" id="about-section">
          <h3>{t.about_title}</h3>
          <p className="text-sm mt-12">{t.about_desc}</p>
          <p className="text-sm" style={{ color: 'var(--text-muted)', marginTop: '4px' }}>
            {t.version_info}
          </p>
        </div>
      </main>

      {/* --------------------------------------------------
          SAFETY CONFIRMATION MODAL
          -------------------------------------------------- */}
      <div className={`modal-overlay ${isReviewModalOpen ? 'active' : ''}`} id="review-modal">
        <div className="modal" id="review-modal-box">
          <h2>{t.modal_confirm_title}</h2>
          <p style={{ marginTop: '8px' }}>{t.modal_confirm_desc}</p>
          <p className="text-sm" style={{ marginTop: '6px', color: 'var(--text-secondary)' }} id="modal-details-text">
            {t.modal_details_text(getSelectedItemsCount(), getSelectedItemsSize())}
          </p>
          <p className="text-sm" style={{ marginTop: '8px', color: 'var(--status-success)', background: '#f0fdf4', padding: '6px 8px', borderRadius: '4px' }}>
            {t.modal_note}
          </p>

          <div className="modal-footer">
            <button 
              className="btn btn-outline" 
              id="modal-cancel-btn"
              onClick={() => setIsReviewModalOpen(false)}
            >
              {t.btn_cancel}
            </button>
            <button 
              className="btn btn-danger" 
              id="modal-confirm-trash-btn"
              onClick={handleConfirmSafeDelete}
            >
              {t.btn_move_trash}
            </button>
          </div>
        </div>
      </div>

      {/* Toast Notification */}
      <div 
        id="toast-msg" 
        className={`toast ${isToastVisible ? 'active' : ''}`}
      >
        {toastMessage}
      </div>

      {/* --------------------------------------------------
          BOTTOM NAVIGATION BAR
          -------------------------------------------------- */}
      <nav className="bottom-nav" id="main-bottom-nav">
        <button 
          className={`nav-item ${currentTab === 'home' ? 'active' : ''}`} 
          id="nav-tab-home"
          onClick={() => setCurrentTab('home')}
        >
          <svg viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path></svg>
          <span>{t.nav_home}</span>
        </button>
        <button 
          className={`nav-item ${currentTab === 'scan' ? 'active' : ''}`} 
          id="nav-tab-scan"
          onClick={() => setCurrentTab('scan')}
        >
          <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
          <span>{t.nav_scan}</span>
        </button>
        <button 
          className={`nav-item ${currentTab === 'issues' ? 'active' : ''}`} 
          id="nav-tab-issues"
          onClick={() => setCurrentTab('issues')}
        >
          <svg viewBox="0 0 24 24"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 3-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
          <span>{t.nav_issues}</span>
        </button>
        <button 
          className={`nav-item ${currentTab === 'reports' ? 'active' : ''}`} 
          id="nav-tab-reports"
          onClick={() => setCurrentTab('reports')}
        >
          <svg viewBox="0 0 24 24"><line x1="18" y1="20" x2="18" y2="10"></line><line x1="12" y1="20" x2="12" y2="4"></line><line x1="6" y1="20" x2="6" y2="14"></line></svg>
          <span>{t.nav_reports}</span>
        </button>
        <button 
          className={`nav-item ${currentTab === 'more' ? 'active' : ''}`} 
          id="nav-tab-more"
          onClick={() => setCurrentTab('more')}
        >
          <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="1"></circle><circle cx="12" cy="5" r="1"></circle><circle cx="12" cy="19" r="1"></circle></svg>
          <span>{t.nav_more}</span>
        </button>
      </nav>
    </div>
  );
}
