import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  HardDrive,
  CheckCircle2,
  CloudUpload,
  Settings,
  RefreshCw,
  FileVideo,
  ChevronRight,
  ChevronDown,
  Folder,
  X,
  Play,
  Server,
  Database,
  ArrowRight,
  User,
  Search,
} from 'lucide-react';
import {
  subscribeToSdEvents,
  fetchLoads,
  patchFile,
  startCopy,
  subscribeToCopyEvents,
  fetchSyncStatus,
} from './api.js';

// ── Stop-motion thumbnail ──────────────────────────────────────────────────────

const StopMotionThumbnail = ({ fileId, onClick }) => {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setFrame((prev) => (prev + 1) % 4);
    }, 200 + Math.random() * 50);
    return () => clearInterval(interval);
  }, []);

  return (
    <div
      className="absolute inset-0 w-full h-full bg-zinc-900 overflow-hidden group/thumb cursor-pointer"
      onClick={onClick}
    >
      {[0, 1, 2, 3].map((i) => (
        <img
          key={i}
          src={`https://picsum.photos/seed/${fileId}-f${i}/320/180?blur=1`}
          alt="thumbnail"
          className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-0 ${
            frame === i
              ? 'opacity-70 mix-blend-luminosity group-hover/thumb:mix-blend-normal group-hover/thumb:opacity-100'
              : 'opacity-0'
          }`}
          referrerPolicy="no-referrer"
        />
      ))}
      <div className="absolute inset-0 flex items-center justify-center bg-black/10 group-hover/thumb:bg-black/30 transition-colors">
        <Play
          className="w-8 h-8 text-white/70 drop-shadow-md opacity-0 group-hover/thumb:opacity-100 transition-opacity"
          fill="currentColor"
        />
      </div>
    </div>
  );
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (!bytes) return '?';
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

function formatDuration(secs) {
  if (!secs) return '--:--';
  const m = Math.floor(secs / 60).toString().padStart(2, '0');
  const s = (secs % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function generateFileName(file, owner, load, jumpedWith) {
  if (!load) return file.original_name;
  const cleanName = owner.replace(/[^a-zA-Z0-9]/g, '');
  const loadStr = `${(load.aircraft || '').replace(/\s+/g, '')}${load.load_number}`;
  const ownerJumper = load.jumpers?.find((j) => j.name === owner);
  const jumpType = (ownerJumper?.formation || ownerJumper?.type || 'Sport').replace(/[^a-zA-Z0-9]/g, '');
  const count = 1 + (jumpedWith?.length || 0);
  const way = count === 1 ? 'solo' : `${count}way`;
  const initials =
    jumpedWith?.length > 0
      ? jumpedWith
          .map((n) =>
            n
              .split(' ')
              .map((p) => p[0].toUpperCase())
              .join('')
          )
          .join('-') + '_'
      : '';
  const date = file.recorded_at?.slice(0, 10) || '';
  return `${date}_${loadStr}_${way}_${jumpType}_${initials}${cleanName}_${file.original_name}`;
}

// ── App ────────────────────────────────────────────────────────────────────────

export default function App() {
  const today     = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  const [step, setStep]             = useState(1);
  const [sdInserted, setSdInserted] = useState(false);
  const [sessionId, setSessionId]   = useState(null);

  const [files, setFiles]                 = useState([]);
  const [expandedDates, setExpandedDates] = useState([today]);

  const [loads, setLoads]                       = useState([]);
  const [manifestDate, setManifestDate]         = useState(today);
  const [isLoadingManifest, setIsLoadingManifest] = useState(false);

  const [cameraOwner, setCameraOwner]             = useState(null);
  const [cameraOwnerSearch, setCameraOwnerSearch] = useState('');

  const [assigningFileId, setAssigningFileId]   = useState(null);
  const [tempAssignment, setTempAssignment]     = useState({ loadId: '', jumpedWith: [] });

  const [copyJobId, setCopyJobId]     = useState(null);
  const [copyProgress, setCopyProgress] = useState(0);
  const [copyDone, setCopyDone]       = useState(false);
  const [syncStatus, setSyncStatus]   = useState(null);

  const [previewFile, setPreviewFile] = useState(null);

  // Load manifest
  useEffect(() => {
    setIsLoadingManifest(true);
    fetchLoads(manifestDate)
      .then(setLoads)
      .catch((err) => console.error('[app] loads:', err))
      .finally(() => setIsLoadingManifest(false));
  }, [manifestDate]);

  // SD card SSE
  useEffect(() => {
    const es = subscribeToSdEvents({
      onSdInserted: ({ sessionId: sid }) => {
        setSessionId(sid);
        setSdInserted(true);
        setTimeout(() => setStep(2), 1500);
      },
      onFilesScanned: ({ sessionId: sid, files: scanned }) => {
        setSessionId(sid);
        setFiles(scanned.map((f) => ({ ...f, selected: false })));
      },
      onSdRemoved: () => {
        setSdInserted(false);
        setSessionId(null);
      },
    });
    return () => es.close();
  }, []);

  // Copy progress SSE
  useEffect(() => {
    if (!copyJobId) return;
    const total = files.filter((f) => f.selected).length || 1;
    let doneCount = 0;

    const es = subscribeToCopyEvents(copyJobId, {
      onFileDone: ({ fileId, localPath }) => {
        doneCount++;
        setFiles((prev) =>
          prev.map((f) => (f.id === fileId ? { ...f, copy_status: 'done', local_path: localPath } : f))
        );
        setCopyProgress(Math.round((doneCount / total) * 100));
      },
      onJobDone: () => {
        setCopyProgress(100);
        setCopyDone(true);
        es.close();
        fetchSyncStatus().then(setSyncStatus).catch(() => {});
      },
    });
    return () => es.close();
  }, [copyJobId]);

  // Derived
  const selectedFiles     = files.filter((f) => f.selected);
  const selectedCount     = selectedFiles.length;
  const totalSelectedSize = selectedFiles.reduce((acc, f) => acc + (f.size_bytes || 0), 0);
  const ownerLoads        = cameraOwner
    ? loads.filter((l) => l.jumpers?.some((j) => j.name === cameraOwner))
    : [];
  const uniqueJumpers = Array.from(
    new Set(loads.flatMap((l) => (l.jumpers || []).map((j) => j.name)))
  ).sort();
  const filesByDate = files.reduce((acc, f) => {
    const d = f.recorded_at?.slice(0, 10) || 'unknown';
    (acc[d] = acc[d] || []).push(f);
    return acc;
  }, {});
  const assigningLoad = loads.find((l) => String(l.id) === String(tempAssignment.loadId));

  const openAssigner = (fileId) => {
    const file = files.find((f) => f.id === fileId);
    setTempAssignment({
      loadId:     file?.load_id ? String(file.load_id) : '',
      jumpedWith: file?.jumped_with || [],
    });
    setAssigningFileId(fileId);
  };

  const saveAssignment = async () => {
    if (!assigningFileId) return;
    const file = files.find((f) => f.id === assigningFileId);
    const load = loads.find((l) => String(l.id) === String(tempAssignment.loadId));
    const finalName = load ? generateFileName(file, cameraOwner, load, tempAssignment.jumpedWith) : null;
    try {
      const updated = await patchFile(assigningFileId, {
        ownerName:  cameraOwner,
        loadId:     tempAssignment.loadId ? Number(tempAssignment.loadId) : null,
        jumpedWith: tempAssignment.jumpedWith,
        finalName,
      });
      setFiles((prev) =>
        prev.map((f) =>
          f.id === assigningFileId ? { ...updated, selected: !!updated.load_id } : f
        )
      );
    } catch (err) {
      console.error('[app] patch file:', err);
    }
    setAssigningFileId(null);
  };

  const toggleJumpedWith = (name) => {
    setTempAssignment((prev) => ({
      ...prev,
      jumpedWith: prev.jumpedWith.includes(name)
        ? prev.jumpedWith.filter((n) => n !== name)
        : [...prev.jumpedWith, name],
    }));
  };

  const startSync = async () => {
    setStep(4);
    setCopyProgress(0);
    setCopyDone(false);
    try {
      const { jobId } = await startCopy(files.filter((f) => f.selected).map((f) => f.id));
      setCopyJobId(jobId);
    } catch (err) {
      console.error('[app] start copy:', err);
    }
  };

  const resetSession = () => {
    setStep(1);
    setSdInserted(false);
    setSessionId(null);
    setFiles([]);
    setCameraOwner(null);
    setCameraOwnerSearch('');
    setCopyJobId(null);
    setCopyProgress(0);
    setCopyDone(false);
    setSyncStatus(null);
  };

  // ────────────────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans selection:bg-emerald-500/30">
      <div className="max-w-2xl mx-auto min-h-screen bg-zinc-900 shadow-2xl overflow-hidden relative flex flex-col">

        {/* Header */}
        <header className="px-6 py-5 border-b border-zinc-800 bg-zinc-900/80 backdrop-blur-md sticky top-0 z-20 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-emerald-500 flex items-center justify-center shadow-[0_0_15px_rgba(16,185,129,0.4)]">
              <CloudUpload className="w-5 h-5 text-zinc-950" />
            </div>
            <div>
              <h1 className="font-bold text-lg tracking-tight leading-none">SkyBox V2.0</h1>
              <div className="flex items-center gap-1.5 mt-1 text-xs text-emerald-400 font-medium">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                </span>
                AP Mode Active
              </div>
            </div>
          </div>
          <button className="p-2 text-zinc-400 hover:text-zinc-100 transition-colors rounded-full hover:bg-zinc-800">
            <Settings className="w-5 h-5" />
          </button>
        </header>

        <main className="flex-1 overflow-y-auto pb-24 relative custom-scrollbar">
          <AnimatePresence mode="wait">

            {/* STEP 1 – Insert SD Card */}
            {step === 1 && (
              <motion.div key="step1"
                initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: -20 }}
                className="p-6 flex flex-col items-center justify-center min-h-[60vh] text-center"
              >
                <div className="relative mb-8">
                  <div className={`w-24 h-24 rounded-full flex items-center justify-center transition-colors duration-500 ${sdInserted ? 'bg-emerald-500/20 text-emerald-400' : 'bg-zinc-800 text-zinc-500'}`}>
                    <HardDrive className={`w-10 h-10 ${sdInserted ? 'animate-pulse' : ''}`} />
                  </div>
                  {sdInserted && (
                    <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }}
                      className="absolute -bottom-2 -right-2 w-8 h-8 bg-emerald-500 rounded-full flex items-center justify-center text-zinc-950 border-4 border-zinc-900"
                    >
                      <CheckCircle2 className="w-5 h-5" />
                    </motion.div>
                  )}
                </div>
                <h2 className="text-2xl font-semibold mb-2">
                  {sdInserted ? 'SD Card Detected' : 'Insert SD Card'}
                </h2>
                <p className="text-zinc-400 mb-8 max-w-[260px]">
                  {sdInserted ? 'Reading footage from camera...' : "Insert your camera's SD card into the USB reader."}
                </p>
                {sdInserted && (
                  <motion.button initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
                    onClick={() => setStep(2)}
                    className="w-full bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-semibold py-4 rounded-xl flex items-center justify-center gap-2 transition-all active:scale-[0.98]"
                  >
                    View Files <ArrowRight className="w-5 h-5" />
                  </motion.button>
                )}
              </motion.div>
            )}

            {/* STEP 2 – Who are you? */}
            {step === 2 && (
              <motion.div key="step2"
                initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}
                className="p-6 flex flex-col min-h-[60vh]"
              >
                <div className="mb-8 mt-4">
                  <div className="w-12 h-12 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center mb-4">
                    <User className="w-6 h-6" />
                  </div>
                  <h2 className="text-2xl font-semibold mb-2">Who are you?</h2>
                  <p className="text-sm text-zinc-400">Select the camera owner to find your loads.</p>
                </div>

                <div className="flex items-center gap-2 mb-4">
                  {[{ label: 'Today', val: today }, { label: 'Yesterday', val: yesterday }].map(({ label, val }) => (
                    <button key={val}
                      onClick={() => setManifestDate(val)}
                      className={`px-3 py-1.5 text-xs rounded-lg border transition-all ${manifestDate === val ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-400' : 'bg-zinc-800/40 border-zinc-700 text-zinc-400 hover:border-zinc-600'}`}
                    >{label}</button>
                  ))}
                  {isLoadingManifest && <RefreshCw className="w-3 h-3 text-zinc-500 animate-spin ml-1" />}
                </div>

                <div className="relative mb-6">
                  <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-zinc-500" />
                  <input type="text" placeholder="Type your name..."
                    value={cameraOwnerSearch}
                    onChange={(e) => setCameraOwnerSearch(e.target.value)}
                    className="w-full bg-zinc-800/50 border border-zinc-700 rounded-xl pl-12 pr-4 py-4 text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 transition-all"
                  />
                </div>

                <div className="flex-1 overflow-y-auto custom-scrollbar -mx-2 px-2">
                  <div className="space-y-2">
                    {uniqueJumpers
                      .filter((j) => j.toLowerCase().includes(cameraOwnerSearch.toLowerCase()))
                      .map((jumper) => {
                        const cnt = loads.filter((l) => l.jumpers?.some((j2) => j2.name === jumper)).length;
                        return (
                          <button key={jumper}
                            onClick={() => { setCameraOwner(jumper); setStep(3); }}
                            className="w-full flex items-center justify-between px-3 py-2.5 bg-zinc-800/20 hover:bg-zinc-800/60 border border-zinc-800/50 hover:border-zinc-700 rounded-lg transition-all text-left group"
                          >
                            <span className="text-sm font-medium text-zinc-300 group-hover:text-emerald-400 transition-colors">{jumper}</span>
                            <div className="flex items-center gap-2">
                              <span className="text-[10px] font-mono text-zinc-500 bg-zinc-900/50 px-1.5 py-0.5 rounded border border-zinc-800/50">
                                {cnt} jump{cnt !== 1 ? 's' : ''}
                              </span>
                              <ChevronRight className="w-4 h-4 text-zinc-600 group-hover:text-emerald-500 transition-colors" />
                            </div>
                          </button>
                        );
                      })}
                    {uniqueJumpers.length === 0 && !isLoadingManifest && (
                      <p className="text-sm text-zinc-500 text-center py-8">
                        No loads found. Try a different date or check Burble.
                      </p>
                    )}
                  </div>
                </div>
              </motion.div>
            )}

            {/* STEP 3 – File Selection */}
            {step === 3 && (
              <motion.div key="step3"
                initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}
                className="p-6"
              >
                <div className="mb-6 flex items-center justify-between">
                  <div>
                    <h2 className="text-xl font-semibold mb-1">Select Footage</h2>
                    <div className="flex items-center gap-2 text-sm text-zinc-400 font-mono">
                      <HardDrive className="w-4 h-4 text-emerald-500/70" />
                      {files.length} file{files.length !== 1 ? 's' : ''} on card
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-[10px] text-zinc-500 uppercase font-mono mb-0.5">Camera Owner</div>
                    <div className="text-sm font-medium text-emerald-400">{cameraOwner}</div>
                  </div>
                </div>

                {files.length === 0 ? (
                  <div className="text-center text-zinc-500 py-16">
                    <FileVideo className="w-10 h-10 mx-auto mb-3 opacity-30" />
                    <p className="text-sm">No video files found on this card.</p>
                    <p className="text-xs mt-1 text-zinc-600">GoPro, Insta360, and DJI folders are scanned automatically.</p>
                  </div>
                ) : (
                  <div className="space-y-4 mb-8">
                    {Object.keys(filesByDate).sort((a, b) => b.localeCompare(a)).map((dateStr) => {
                      const dateFiles = filesByDate[dateStr];
                      const isExpanded = expandedDates.includes(dateStr);
                      const selectedInDate = dateFiles.filter((f) => f.selected).length;
                      return (
                        <div key={dateStr} className="bg-zinc-800/20 rounded-2xl border border-zinc-800/50 overflow-hidden">
                          <button
                            onClick={() => setExpandedDates((prev) =>
                              prev.includes(dateStr) ? prev.filter((d) => d !== dateStr) : [...prev, dateStr]
                            )}
                            className="w-full px-4 py-3 flex items-center justify-between bg-zinc-800/40 hover:bg-zinc-800/60 transition-colors"
                          >
                            <div className="flex items-center gap-3">
                              <Folder className="w-4 h-4 text-emerald-500" />
                              <span className="font-medium text-sm text-zinc-200">
                                {dateStr === today ? 'Today' : dateStr === yesterday ? 'Yesterday' : dateStr}
                              </span>
                              <span className="text-xs text-zinc-500 font-mono bg-zinc-900 px-2 py-0.5 rounded-full">
                                {dateFiles.length} files
                              </span>
                            </div>
                            <div className="flex items-center gap-3">
                              {selectedInDate > 0 && (
                                <span className="text-[10px] text-emerald-400 bg-emerald-400/10 px-2 py-0.5 rounded-full font-medium">
                                  {selectedInDate} selected
                                </span>
                              )}
                              {isExpanded ? <ChevronDown className="w-4 h-4 text-zinc-500" /> : <ChevronRight className="w-4 h-4 text-zinc-500" />}
                            </div>
                          </button>

                          <AnimatePresence>
                            {isExpanded && (
                              <motion.div
                                initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                                className="overflow-hidden"
                              >
                                <div className="p-2 grid grid-cols-2 gap-2">
                                  {dateFiles.map((file) => {
                                    const assignedLoad = file.load_id ? loads.find((l) => l.id === file.load_id) : null;
                                    return (
                                      <div key={file.id}
                                        onClick={() => openAssigner(file.id)}
                                        className={`group relative flex flex-col rounded-xl border transition-all cursor-pointer overflow-hidden aspect-video ${
                                          file.selected
                                            ? 'border-emerald-500/50 shadow-[0_0_15px_rgba(16,185,129,0.15)]'
                                            : 'border-zinc-800 hover:border-zinc-700'
                                        }`}
                                      >
                                        <StopMotionThumbnail
                                          fileId={String(file.id)}
                                          onClick={(e) => { e.stopPropagation(); setPreviewFile(file); }}
                                        />
                                        <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-black/20 pointer-events-none" />

                                        {assignedLoad && (
                                          <div className="absolute top-2 left-2 z-20">
                                            <div className="px-2 py-0.5 text-[9px] font-medium rounded-full backdrop-blur-md border bg-emerald-500 text-zinc-950 border-emerald-400">
                                              {assignedLoad.aircraft} {assignedLoad.load_number}
                                            </div>
                                          </div>
                                        )}

                                        <div className="absolute top-2 right-2 z-10">
                                          <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors ${
                                            file.selected
                                              ? 'bg-emerald-500 border-emerald-500 text-zinc-950'
                                              : 'border-white/50 bg-black/20 text-transparent backdrop-blur-sm'
                                          }`}>
                                            <CheckCircle2 className="w-3 h-3" />
                                          </div>
                                        </div>

                                        <div className="absolute bottom-0 left-0 right-0 p-2 flex flex-col gap-0.5 z-10 pointer-events-none">
                                          <div className="flex items-center justify-between">
                                            <span className="text-[9px] text-zinc-300 font-mono bg-black/40 backdrop-blur-sm px-1 py-0.5 rounded truncate max-w-[60%]">
                                              {file.camera_type || 'video'}
                                            </span>
                                            <div className="flex items-center gap-1.5">
                                              <span className="text-[9px] text-zinc-300 font-mono">{formatDuration(file.duration_secs)}</span>
                                              <span className="text-[9px] text-zinc-400 font-mono">· {formatBytes(file.size_bytes)}</span>
                                            </div>
                                          </div>
                                          <h3 className="font-medium text-xs truncate text-white drop-shadow-md">
                                            {assignedLoad && cameraOwner
                                              ? generateFileName(file, cameraOwner, assignedLoad, file.jumped_with)
                                              : file.original_name}
                                          </h3>
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </div>
                      );
                    })}
                  </div>
                )}
              </motion.div>
            )}

            {/* STEP 4 – Copy & Sync */}
            {step === 4 && (
              <motion.div key="step4"
                initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }}
                className="p-6 flex flex-col items-center justify-center min-h-[60vh]"
              >
                <div className="w-full max-w-[280px] mb-12">
                  <div className="flex justify-between items-end mb-2">
                    <span className="text-sm font-medium text-zinc-300">
                      {copyDone ? 'Copy Complete' : 'Copying to NVMe...'}
                    </span>
                    <span className="text-2xl font-light text-emerald-400 font-mono">{copyProgress}%</span>
                  </div>
                  <div className="h-2 w-full bg-zinc-800 rounded-full overflow-hidden">
                    <motion.div className="h-full bg-emerald-500 rounded-full"
                      initial={{ width: 0 }} animate={{ width: `${copyProgress}%` }}
                      transition={{ ease: 'linear', duration: 0.5 }}
                    />
                  </div>
                </div>

                <div className="w-full bg-zinc-800/30 rounded-2xl p-6 border border-zinc-800">
                  <h3 className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-6 text-center">3-2-1 Backup Flow</h3>
                  <div className="flex justify-between items-center relative">
                    <div className="absolute top-1/2 left-0 right-0 h-0.5 bg-zinc-800 -z-10 -translate-y-1/2" />
                    <div className="absolute top-1/2 left-0 right-0 h-0.5 bg-emerald-500/50 -z-10 -translate-y-1/2"
                      style={{ clipPath: `inset(0 ${100 - copyProgress}% 0 0)` }} />

                    {[
                      { label: 'Pi NVMe',   icon: HardDrive, active: copyProgress > 0 },
                      { label: 'Nextcloud', icon: Server,    active: copyDone && syncStatus?.online },
                      { label: 'Offsite',   icon: Database,  active: false },
                    ].map(({ label, icon: Icon, active }) => (
                      <div key={label} className="flex flex-col items-center gap-2">
                        <div className={`w-12 h-12 rounded-xl flex items-center justify-center bg-zinc-900 border-2 ${active ? 'border-emerald-500 text-emerald-400' : 'border-zinc-700 text-zinc-500'}`}>
                          <Icon className="w-5 h-5" />
                        </div>
                        <span className="text-[10px] text-zinc-400 font-mono">{label}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="w-full mt-8 bg-zinc-800/30 rounded-2xl p-4 border border-zinc-800">
                  <h3 className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-4">Files in Queue</h3>
                  <div className="space-y-2 max-h-[250px] overflow-y-auto custom-scrollbar pr-2">
                    {files.filter((f) => f.selected).map((file) => {
                      const load = file.load_id ? loads.find((l) => l.id === file.load_id) : null;
                      return (
                        <div key={file.id} className="flex items-start justify-between bg-zinc-900/50 p-3 rounded-lg border border-zinc-800/50">
                          <div className="flex items-start gap-3 overflow-hidden">
                            <CheckCircle2 className={`w-4 h-4 shrink-0 mt-0.5 ${file.copy_status === 'done' ? 'text-emerald-500' : 'text-zinc-600'}`} />
                            <span className="text-xs text-zinc-300 break-all font-mono leading-relaxed">
                              {load && cameraOwner ? generateFileName(file, cameraOwner, load, file.jumped_with) : file.original_name}
                            </span>
                          </div>
                          <span className="text-[10px] text-zinc-500 font-mono shrink-0 ml-3">{formatBytes(file.size_bytes)}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {copyDone && (
                  <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mt-8 text-center">
                    {syncStatus && (
                      <p className="text-xs text-zinc-500 mb-2">
                        {syncStatus.online
                          ? `Syncing to Nextcloud (${syncStatus.pending} file${syncStatus.pending !== 1 ? 's' : ''} pending)`
                          : 'Pi will sync to Nextcloud when connected to the internet.'}
                      </p>
                    )}
                    <p className="text-sm text-zinc-400 mb-4">You can now safely disconnect. The Pi handles the rest.</p>
                    <button onClick={resetSession} className="text-emerald-400 text-sm font-medium hover:text-emerald-300">
                      Start New Session
                    </button>
                  </motion.div>
                )}
              </motion.div>
            )}

          </AnimatePresence>

          {/* Assignment Drawer */}
          <AnimatePresence>
            {assigningFileId && (
              <motion.div
                initial={{ opacity: 0, y: '100%' }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: '100%' }}
                transition={{ type: 'spring', damping: 25, stiffness: 300 }}
                className="fixed inset-x-0 bottom-0 z-50 bg-zinc-900 border-t border-zinc-800 rounded-t-3xl shadow-[0_-10px_40px_rgba(0,0,0,0.5)] max-h-[85vh] flex flex-col"
              >
                <div className="p-4 border-b border-zinc-800 flex items-center justify-between sticky top-0 bg-zinc-900/90 backdrop-blur-md rounded-t-3xl z-10">
                  <h3 className="font-semibold text-lg">Assign Video</h3>
                  <button onClick={() => setAssigningFileId(null)} className="p-2 bg-zinc-800 rounded-full text-zinc-400 hover:text-white transition-colors">
                    <X className="w-5 h-5" />
                  </button>
                </div>

                <div className="p-6 overflow-y-auto custom-scrollbar flex-1">
                  <div className="mb-8">
                    <label className="block text-xs font-medium text-zinc-400 uppercase tracking-wider mb-3">Which load was this?</label>
                    <div className="flex flex-wrap gap-2">
                      {ownerLoads.map((load) => {
                        const isSel = String(tempAssignment.loadId) === String(load.id);
                        return (
                          <button key={load.id}
                            onClick={() => setTempAssignment((prev) => ({ ...prev, loadId: isSel ? '' : String(load.id), jumpedWith: [] }))}
                            className={`flex flex-col items-start px-4 py-2.5 rounded-xl border transition-all ${isSel ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-400' : 'bg-zinc-800/50 border-zinc-700 text-zinc-300 hover:border-zinc-600'}`}
                          >
                            <span className="text-sm font-medium">{load.aircraft} {load.load_number}</span>
                          </button>
                        );
                      })}
                      {ownerLoads.length === 0 && (
                        <div className="text-sm text-zinc-500 italic">No loads found for {cameraOwner}.</div>
                      )}
                    </div>
                  </div>

                  <AnimatePresence>
                    {tempAssignment.loadId && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
                        className="overflow-hidden"
                      >
                        <div className="mb-6">
                          <label className="block text-xs font-medium text-zinc-400 uppercase tracking-wider mb-3">
                            Who did you jump with? (Optional)
                          </label>
                          <div className="flex flex-wrap gap-2">
                            {(assigningLoad?.jumpers || [])
                              .filter((j) => j.name !== cameraOwner)
                              .map((jumper) => {
                                const isSel = tempAssignment.jumpedWith.includes(jumper.name);
                                return (
                                  <button key={jumper.name} onClick={() => toggleJumpedWith(jumper.name)}
                                    className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs transition-all ${isSel ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-400' : 'bg-zinc-800/50 border-zinc-700 text-zinc-400 hover:border-zinc-600'}`}
                                  >
                                    <span>{jumper.name}</span>
                                    {(jumper.formation || jumper.type) && (
                                      <span className={`text-[10px] uppercase font-mono px-1.5 py-0.5 rounded ${isSel ? 'bg-emerald-500/20 text-emerald-500' : 'bg-zinc-800 text-zinc-500'}`}>
                                        {jumper.formation || jumper.type}
                                      </span>
                                    )}
                                  </button>
                                );
                              })}
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                <div className="p-4 border-t border-zinc-800 bg-zinc-900 sticky bottom-0">
                  <button onClick={saveAssignment} disabled={!tempAssignment.loadId}
                    className="w-full bg-emerald-500 hover:bg-emerald-400 disabled:bg-zinc-800 disabled:text-zinc-500 text-zinc-950 font-semibold py-3.5 rounded-xl transition-all active:scale-[0.98]"
                  >
                    Save Assignment
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </main>

        {/* Bottom action bar (step 3) */}
        <AnimatePresence>
          {step === 3 && selectedCount > 0 && (
            <motion.div initial={{ y: 100 }} animate={{ y: 0 }} exit={{ y: 100 }}
              className="absolute bottom-0 left-0 right-0 p-6 bg-zinc-900/90 backdrop-blur-xl border-t border-zinc-800 z-30"
            >
              <div className="flex items-center justify-between mb-4">
                <span className="text-sm text-zinc-400">{selectedCount} file{selectedCount !== 1 ? 's' : ''} selected</span>
                <span className="text-sm font-mono text-zinc-200">{formatBytes(totalSelectedSize)}</span>
              </div>
              <button onClick={startSync}
                className="w-full bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-semibold py-4 rounded-xl flex items-center justify-center gap-2 transition-all active:scale-[0.98] shadow-[0_0_20px_rgba(16,185,129,0.2)]"
              >
                <CloudUpload className="w-5 h-5" />
                Copy & Queue Sync
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Video preview modal */}
        <AnimatePresence>
          {previewFile && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0 z-50 bg-black/95 backdrop-blur-sm flex flex-col"
            >
              <div className="px-4 py-4 flex justify-between items-center">
                <div>
                  <h3 className="font-medium text-zinc-100">{previewFile.original_name}</h3>
                  <span className="inline-block mt-1 text-[10px] text-emerald-400 font-mono border border-emerald-400/30 bg-emerald-400/10 px-1.5 py-0.5 rounded">
                    {previewFile.camera_type?.toUpperCase() || 'VIDEO'}
                  </span>
                </div>
                <button onClick={() => setPreviewFile(null)} className="p-2 bg-zinc-800/80 rounded-full text-zinc-300 hover:text-white transition-colors">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="flex-1 flex items-center justify-center p-4">
                <video src={`/api/files/${previewFile.id}/stream`} controls autoPlay playsInline
                  className="max-w-full max-h-full rounded-lg shadow-2xl border border-zinc-800"
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>

      </div>
    </div>
  );
}
