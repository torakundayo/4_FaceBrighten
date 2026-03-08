import { useState, useCallback, useEffect, useRef } from "react";
import { supabase } from "../lib/supabase";

type ProcessingStatus =
  | "idle"
  | "uploading"
  | "processing"
  | "completed"
  | "error";

interface ProcessingStats {
  face_detected: boolean;
  luminance_before?: number;
  luminance_after?: number;
  luminance_change?: number;
  face_ratio?: number;
  image_size?: string;
  mask_image?: string;
  params?: {
    lift: number;
    gamma: number;
    offset: number;
    sat_boost: number;
  };
}

interface UsageInfo {
  today_count: number;
  month_count: number;
  daily_limit: number;
  monthly_limit: number;
}

export default function ImageProcessor() {
  const [status, setStatus] = useState<ProcessingStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [resultBlobUrl, setResultBlobUrl] = useState<string | null>(null);
  const [stats, setStats] = useState<ProcessingStats | null>(null);
  const [processSec, setProcessSec] = useState<number | null>(null);
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const [sliderPosition, setSliderPosition] = useState(50);
  const [dragActive, setDragActive] = useState(false);
  const [activeStep, setActiveStep] = useState(0);
  const [showMask, setShowMask] = useState(false);
  const [brightnessStrength, setBrightnessStrength] = useState(100);
  const [maxBlobUrl, setMaxBlobUrl] = useState<string | null>(null);
  const [showAdjust, setShowAdjust] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sliderRef = useRef<HTMLDivElement>(null);
  const isDraggingSlider = useRef(false);
  const stepTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 使用状況を取得 + プリウォーム
  useEffect(() => {
    fetchUsage();
    // ページロード時にプリウォーム（認証付き）
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        fetch("/api/warmup", {
          method: "POST",
          headers: { Authorization: `Bearer ${session.access_token}` },
        }).catch(() => {});
      }
    });
  }, []);

  // Pre-render 200% brightness image for real-time slider preview
  useEffect(() => {
    if (status !== "completed" || !previewUrl || !resultBlobUrl) return;

    let cancelled = false;
    let createdUrl: string | null = null;

    const origImg = new Image();
    const procImg = new Image();
    origImg.src = previewUrl;
    procImg.src = resultBlobUrl;

    Promise.all([origImg.decode(), procImg.decode()])
      .then(() => {
        if (cancelled) return;

        const w = origImg.naturalWidth;
        const h = origImg.naturalHeight;
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        ctx.drawImage(origImg, 0, 0);
        const origData = ctx.getImageData(0, 0, w, h);
        ctx.drawImage(procImg, 0, 0, w, h);
        const procData = ctx.getImageData(0, 0, w, h);

        // 200% = 2 * processed - original
        const out = ctx.createImageData(w, h);
        const od = origData.data;
        const pd = procData.data;
        const rd = out.data;
        for (let i = 0; i < od.length; i += 4) {
          rd[i] = Math.max(0, Math.min(255, 2 * pd[i] - od[i]));
          rd[i + 1] = Math.max(0, Math.min(255, 2 * pd[i + 1] - od[i + 1]));
          rd[i + 2] = Math.max(0, Math.min(255, 2 * pd[i + 2] - od[i + 2]));
          rd[i + 3] = 255;
        }
        ctx.putImageData(out, 0, 0);

        canvas.toBlob(
          (blob) => {
            if (blob && !cancelled) {
              createdUrl = URL.createObjectURL(blob);
              setMaxBlobUrl(createdUrl);
            }
          },
          "image/jpeg",
          0.95
        );
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [status, previewUrl, resultBlobUrl]);

  async function fetchUsage() {
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) return;

      const res = await fetch("/api/usage", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (res.ok) {
        setUsage(await res.json());
      }
    } catch {
      // Usage fetch failed, non-critical
    }
  }

  function handleFile(file: File) {
    // Validate file type
    if (!file.type.startsWith("image/")) {
      setError("画像ファイルを選択してください（JPG, PNG）");
      return;
    }

    // Validate file size (10MB)
    if (file.size > 10 * 1024 * 1024) {
      setError("ファイルサイズは10MB以下にしてください");
      return;
    }

    // Check usage limits
    if (usage && usage.today_count >= usage.daily_limit) {
      setError(
        `本日の処理上限（${usage.daily_limit}枚）に達しました。明日またお試しください。`
      );
      return;
    }

    setError(null);
    setResultUrl(null);
    if (resultBlobUrl) URL.revokeObjectURL(resultBlobUrl);
    setResultBlobUrl(null);
    setStats(null);
    setProcessSec(null);
    setSliderPosition(50);

    // Create preview
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);

    processImage(file);
  }

  async function processImage(file: File) {
    setStatus("uploading");

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) {
        setError("ログインが必要です");
        setStatus("error");
        return;
      }

      // Upload and process
      setStatus("processing");
      setActiveStep(0);
      // Simulate step progression (backend is a single call)
      stepTimerRef.current = setInterval(() => {
        setActiveStep((prev) => (prev < 4 ? prev + 1 : prev));
      }, 1800);

      const formData = new FormData();
      formData.append("image", file);

      const res = await fetch("/api/process", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
        body: formData,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "処理に失敗しました");
      }

      const data = await res.json().catch(() => ({}));

      if (!data.stats?.face_detected) {
        if (stepTimerRef.current) clearInterval(stepTimerRef.current);
        setError("顔が検出されませんでした。人物が写っている写真をお試しください。");
        setStatus("error");
        return;
      }

      if (stepTimerRef.current) clearInterval(stepTimerRef.current);
      setActiveStep(4);
      setResultUrl(data.download_url);
      setStats(data.stats);
      setProcessSec(data.process_sec ?? null);

      // Fetch result image with auth to create a blob URL for preview
      if (data.download_url) {
        try {
          const imgRes = await fetch(data.download_url, {
            headers: { Authorization: `Bearer ${session.access_token}` },
          });
          if (imgRes.ok) {
            const blob = await imgRes.blob();
            setResultBlobUrl(URL.createObjectURL(blob));
          }
        } catch {
          // Preview will fall back to not showing, download still works
        }
      }

      setStatus("completed");

      // Refresh usage
      fetchUsage();
    } catch (err) {
      if (stepTimerRef.current) clearInterval(stepTimerRef.current);
      setError(err instanceof Error ? err.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    setDragActive(true);
  }

  function reset() {
    if (stepTimerRef.current) clearInterval(stepTimerRef.current);
    setStatus("idle");
    setActiveStep(0);
    setError(null);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    if (resultBlobUrl) URL.revokeObjectURL(resultBlobUrl);
    setPreviewUrl(null);
    setResultUrl(null);
    setResultBlobUrl(null);
    setStats(null);
    setProcessSec(null);
    setSliderPosition(50);
    setShowMask(false);
    if (maxBlobUrl) URL.revokeObjectURL(maxBlobUrl);
    setMaxBlobUrl(null);
    setBrightnessStrength(100);
    setShowAdjust(false);
  }

  // Slider logic
  const updateSlider = useCallback((clientX: number) => {
    const el = sliderRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pct = Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100));
    setSliderPosition(pct);
  }, []);

  const handleSliderPointerDown = useCallback(
    (e: React.PointerEvent) => {
      isDraggingSlider.current = true;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      updateSlider(e.clientX);
    },
    [updateSlider]
  );

  const handleSliderPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (isDraggingSlider.current) updateSlider(e.clientX);
    },
    [updateSlider]
  );

  const handleSliderPointerUp = useCallback(() => {
    isDraggingSlider.current = false;
  }, []);

  async function handleDownload() {
    if (!previewUrl || !resultBlobUrl) return;
    try {
      if (brightnessStrength === 100) {
        // Direct download of server result (best quality)
        const a = document.createElement("a");
        a.href = resultBlobUrl;
        a.download = "face_brighten_result.jpg";
        a.click();
      } else {
        // Blend at full resolution with adjusted strength
        const origImg = new Image();
        const procImg = new Image();
        origImg.src = previewUrl;
        procImg.src = resultBlobUrl;
        await Promise.all([origImg.decode(), procImg.decode()]);

        const w = origImg.naturalWidth;
        const h = origImg.naturalHeight;
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d")!;

        ctx.drawImage(origImg, 0, 0);
        const origData = ctx.getImageData(0, 0, w, h);
        ctx.drawImage(procImg, 0, 0, w, h);
        const procData = ctx.getImageData(0, 0, w, h);

        const s = brightnessStrength / 100;
        const od = origData.data;
        const pd = procData.data;
        for (let i = 0; i < od.length; i += 4) {
          od[i] = Math.max(0, Math.min(255, od[i] + (pd[i] - od[i]) * s));
          od[i + 1] = Math.max(0, Math.min(255, od[i + 1] + (pd[i + 1] - od[i + 1]) * s));
          od[i + 2] = Math.max(0, Math.min(255, od[i + 2] + (pd[i + 2] - od[i + 2]) * s));
        }
        ctx.putImageData(origData, 0, 0);

        canvas.toBlob(
          (blob) => {
            if (blob) {
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = "face_brighten_result.jpg";
              a.click();
              URL.revokeObjectURL(url);
            }
          },
          "image/jpeg",
          0.95
        );
      }
    } catch {
      setError("ダウンロードに失敗しました");
    }
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    window.location.href = "/";
  }

  const remaining = usage
    ? usage.daily_limit - usage.today_count
    : null;

  return (
    <div className="min-h-screen bg-surface-950">
      {/* Header */}
      <header className="border-b border-surface-800/50 bg-surface-950/80 backdrop-blur-xl">
        <div className="max-w-5xl mx-auto px-4 h-16 flex items-center justify-between">
          <a href="/" className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-brand-400 to-brand-600 flex items-center justify-center">
              <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2.25m6.364.386-1.591 1.591M21 12h-2.25m-.386 6.364-1.591-1.591M12 18.75V21m-4.773-4.227-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z" />
              </svg>
            </div>
            <span className="font-bold text-lg text-surface-100">Face Brighten</span>
          </a>

          <div className="flex items-center gap-4">
            {remaining !== null && (
              <div className="text-sm text-surface-400">
                本日の残り:{" "}
                <span className={remaining <= 1 ? "text-amber-400 font-semibold" : "text-brand-400 font-semibold"}>
                  {remaining}枚
                </span>
              </div>
            )}
            <button
              onClick={handleLogout}
              className="text-sm text-surface-500 hover:text-surface-300 transition-colors cursor-pointer"
            >
              ログアウト
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-12">
        {/* Upload Area */}
        {status === "idle" && (
          <div
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={() => setDragActive(false)}
            onClick={() => fileInputRef.current?.click()}
            className={`relative border-2 border-dashed rounded-2xl p-16 text-center cursor-pointer transition-all duration-200 ${
              dragActive
                ? "border-brand-400 bg-brand-500/5"
                : "border-surface-700 hover:border-surface-500 hover:bg-surface-800/30"
            }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleFile(file);
              }}
            />
            <div className="w-16 h-16 rounded-2xl bg-surface-800 flex items-center justify-center mx-auto mb-6">
              <svg xmlns="http://www.w3.org/2000/svg" className="w-8 h-8 text-surface-400" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" />
              </svg>
            </div>
            <p className="text-lg font-medium text-surface-200 mb-2">
              ドラッグ&ドロップ、またはクリックして選択
            </p>
            <p className="text-sm text-surface-500">
              JPG, PNG, WebP &middot; 最大10MB &middot; 最大4000px
            </p>
          </div>
        )}

        {/* Processing State */}
        {(status === "uploading" || status === "processing") && previewUrl && (
          <div className="space-y-8">
            <div className="relative rounded-2xl overflow-hidden shadow-2xl">
              <img
                src={previewUrl}
                alt="処理中の画像"
                className="w-full opacity-50"
              />
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/40 backdrop-blur-sm">
                <div className="w-12 h-12 border-4 border-brand-500 border-t-transparent rounded-full animate-spin mb-4"></div>
                <p className="text-lg font-medium text-white">
                  {status === "uploading" ? "アップロード中..." : "AI処理中..."}
                </p>
                <p className="text-sm text-surface-300 mt-2">
                  {status === "processing" &&
                    "SegFormer AI + シネマグレード・カラーグレーディングで処理しています"}
                </p>
              </div>
            </div>

            {status === "processing" && (
              <div className="bg-surface-800/50 border border-surface-700/50 rounded-xl p-6">
                {/* Progress bar */}
                <div className="h-1.5 bg-surface-700 rounded-full mb-5 overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-brand-500 to-brand-400 rounded-full transition-all duration-700 ease-out"
                    style={{ width: `${((activeStep + 1) / 5) * 100}%` }}
                  />
                </div>
                <div className="space-y-3">
                  {[
                    "AIが顔のパーツを認識",
                    "補正マスクを生成",
                    "カラーグレーディング",
                    "スキントーン保持処理",
                    "画像を生成",
                  ].map((step, i) => (
                    <div key={i} className="flex items-center gap-3 text-sm">
                      {i < activeStep ? (
                        <div className="w-5 h-5 rounded-full bg-brand-500/30 flex items-center justify-center">
                          <svg className="w-3 h-3 text-brand-400" fill="none" viewBox="0 0 24 24" strokeWidth="3" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                          </svg>
                        </div>
                      ) : i === activeStep ? (
                        <div className="w-5 h-5 rounded-full bg-brand-500/20 flex items-center justify-center animate-pulse">
                          <div className="w-2 h-2 rounded-full bg-brand-400"></div>
                        </div>
                      ) : (
                        <div className="w-5 h-5 rounded-full bg-surface-700/50 flex items-center justify-center">
                          <div className="w-2 h-2 rounded-full bg-surface-600"></div>
                        </div>
                      )}
                      <span className={
                        i < activeStep
                          ? "text-surface-400"
                          : i === activeStep
                            ? "text-surface-200 font-medium"
                            : "text-surface-600"
                      }>
                        {step}{i === activeStep ? "..." : ""}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Error State */}
        {error && (
          <div className="mt-6 bg-red-500/10 border border-red-500/20 rounded-xl p-6">
            <p className="text-red-400">{error}</p>
            <button
              onClick={reset}
              className="mt-4 text-sm text-red-300 hover:text-red-200 underline cursor-pointer"
            >
              やり直す
            </button>
          </div>
        )}

        {/* Result */}
        {status === "completed" && previewUrl && resultBlobUrl && (
          <div className="space-y-8">
            {/* Before/After Slider */}
            <div
              ref={sliderRef}
              className="relative w-full overflow-hidden rounded-2xl cursor-col-resize select-none shadow-2xl"
              onPointerDown={handleSliderPointerDown}
              onPointerMove={handleSliderPointerMove}
              onPointerUp={handleSliderPointerUp}
            >
              {/* Before image (full width, determines container height — already loaded) */}
              <img
                src={previewUrl}
                alt="補正前"
                className="w-full h-auto block"
                draggable={false}
              />
              {/* After image (clipped from right) - opacity-based brightness blending */}
              <div
                className="absolute inset-0"
                style={{ clipPath: `inset(0 0 0 ${sliderPosition}%)` }}
              >
                <img
                  src={previewUrl}
                  alt=""
                  className="absolute inset-0 w-full h-full object-cover"
                  draggable={false}
                />
                <img
                  src={maxBlobUrl || resultBlobUrl}
                  alt="補正後"
                  className="absolute inset-0 w-full h-full object-cover"
                  draggable={false}
                  style={maxBlobUrl ? { opacity: brightnessStrength / 200 } : undefined}
                />
              </div>
              {/* Divider line */}
              <div
                className="absolute top-0 bottom-0 w-0.5 bg-white shadow-lg z-10"
                style={{ left: `${sliderPosition}%`, transform: "translateX(-50%)" }}
              >
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-10 h-10 bg-white rounded-full shadow-lg flex items-center justify-center">
                  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" className="text-surface-700">
                    <path d="M6 10L2 10M2 10L5 7M2 10L5 13M14 10L18 10M18 10L15 7M18 10L15 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
              </div>
              {/* Labels */}
              <div className="absolute top-4 left-4 bg-black/60 backdrop-blur-sm text-white text-sm px-3 py-1.5 rounded-full font-medium z-20">
                補正前
              </div>
              <div className="absolute top-4 right-4 bg-black/60 backdrop-blur-sm text-white text-sm px-3 py-1.5 rounded-full font-medium z-20">
                補正後
              </div>
            </div>

            {/* Brightness adjustment slider */}
            {maxBlobUrl && (
              <div className="bg-surface-800/50 border border-surface-700/50 rounded-xl">
                <button
                  onClick={() => setShowAdjust(!showAdjust)}
                  className="w-full flex items-center justify-between p-6 cursor-pointer"
                >
                  <h3 className="text-sm font-semibold text-surface-300">
                    結果を微調整する
                  </h3>
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className={`w-4 h-4 text-surface-400 transition-transform ${showAdjust ? "rotate-180" : ""}`}
                    fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                  </svg>
                </button>
                {showAdjust && (
                  <div className="px-6 pb-6">
                    <div className="flex items-center justify-between mb-3">
                      <label className="text-sm text-surface-400">明るさ補正</label>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-mono text-surface-300">{brightnessStrength}%</span>
                        {brightnessStrength !== 100 && (
                          <button
                            onClick={() => setBrightnessStrength(100)}
                            className="text-xs text-brand-400 hover:text-brand-300 cursor-pointer"
                          >
                            自動に戻す
                          </button>
                        )}
                      </div>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={200}
                      value={brightnessStrength}
                      onChange={(e) => setBrightnessStrength(Number(e.target.value))}
                      className="w-full accent-brand-500"
                    />
                    <div className="flex justify-between text-xs text-surface-600 mt-1">
                      <span>補正なし</span>
                      <span>自動</span>
                      <span>最大</span>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Low correction notice */}
            {stats && stats.luminance_before != null && stats.luminance_before >= 90 && (
              <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-5 flex gap-4 items-start">
                <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5 text-amber-400 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" />
                </svg>
                <div>
                  <p className="text-amber-300 text-sm font-medium">
                    この写真は顔の明るさが十分なため、補正効果が小さくなっています
                  </p>
                  <p className="text-amber-400/70 text-xs mt-1">
                    補正前の顔平均輝度: {stats.luminance_before}/255 — 逆光で顔が暗い写真ほど、補正効果が大きくなります
                  </p>
                </div>
              </div>
            )}

            {/* Stats */}
            {stats && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="bg-surface-800/50 border border-surface-700/50 rounded-xl p-4 text-center">
                  <p className="text-2xl font-bold text-brand-400">
                    +{stats.luminance_change}
                  </p>
                  <p className="text-xs text-surface-500 mt-1">輝度変化</p>
                </div>
                <div className="bg-surface-800/50 border border-surface-700/50 rounded-xl p-4 text-center">
                  <p className="text-2xl font-bold text-surface-200">
                    {stats.face_ratio}%
                  </p>
                  <p className="text-xs text-surface-500 mt-1">補正領域</p>
                </div>
                <div className="bg-surface-800/50 border border-surface-700/50 rounded-xl p-4 text-center">
                  <p className="text-2xl font-bold text-surface-200">
                    {processSec ?? "—"}秒
                  </p>
                  <p className="text-xs text-surface-500 mt-1">処理時間</p>
                </div>
                <div className="bg-surface-800/50 border border-surface-700/50 rounded-xl p-4 text-center">
                  <p className="text-2xl font-bold text-surface-200">
                    {stats.image_size}
                  </p>
                  <p className="text-xs text-surface-500 mt-1">画像サイズ</p>
                </div>
              </div>
            )}

            {/* Grading Parameters */}
            {stats?.params && (
              <div className="bg-surface-800/50 border border-surface-700/50 rounded-xl p-6">
                <h3 className="text-sm font-semibold text-surface-300 mb-4">
                  自動算出パラメータ（Lift/Gamma/Offset）
                </h3>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                  <div>
                    <span className="text-surface-500">Lift</span>
                    <p className="text-surface-200 font-mono">+{stats.params.lift}</p>
                  </div>
                  <div>
                    <span className="text-surface-500">Gamma</span>
                    <p className="text-surface-200 font-mono">+{stats.params.gamma}</p>
                  </div>
                  <div>
                    <span className="text-surface-500">Offset</span>
                    <p className="text-surface-200 font-mono">+{stats.params.offset}</p>
                  </div>
                  <div>
                    <span className="text-surface-500">彩度</span>
                    <p className="text-surface-200 font-mono">+{stats.params.sat_boost}%</p>
                  </div>
                </div>
              </div>
            )}

            {/* Mask visualization (collapsible) */}
            {stats?.mask_image && (
              <div className="bg-surface-800/50 border border-surface-700/50 rounded-xl">
                <button
                  onClick={() => setShowMask(!showMask)}
                  className="w-full flex items-center justify-between p-6 cursor-pointer"
                >
                  <h3 className="text-sm font-semibold text-surface-300">
                    補正マスク（白い部分ほど強く補正）
                  </h3>
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className={`w-4 h-4 text-surface-400 transition-transform ${showMask ? "rotate-180" : ""}`}
                    fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                  </svg>
                </button>
                {showMask && (
                  <div className="px-6 pb-6">
                    <div className="rounded-lg overflow-hidden bg-black">
                      <img
                        src={stats.mask_image}
                        alt="補正マスク"
                        className="w-full h-auto opacity-90"
                      />
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Actions */}
            <div className="flex flex-col sm:flex-row gap-4">
              <button
                onClick={handleDownload}
                className="flex-1 inline-flex items-center justify-center gap-2 bg-brand-500 hover:bg-brand-600 text-white py-3 px-6 rounded-xl font-semibold transition-colors cursor-pointer"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
                </svg>
                ダウンロード
              </button>
              <button
                onClick={reset}
                className="flex-1 inline-flex items-center justify-center gap-2 border border-surface-600 hover:border-surface-500 text-surface-200 py-3 px-6 rounded-xl font-medium transition-colors cursor-pointer"
              >
                別の画像を処理
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
