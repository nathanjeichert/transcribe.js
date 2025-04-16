"use client";                                      // Next‑JS client component

import React, { useState, useEffect } from "react";

/* ────────────────  TYPES  ──────────────── */
interface TranscriptTurn {
  speaker: string;
  text: string;
}

interface CaseInfo {
  case_name?: string;
  case_number?: string;
  firm_name?: string;
  input_date?: string;
  input_time?: string;
  location?: string;
}

/* ───────────  UTILITY FUNCTIONS  ─────────── */
const hhmmss = (seconds: number) =>
  [3600, 60, 1]
    .map((d) => String(Math.floor(seconds / d) % 60).padStart(2, "0"))
    .join(":");

const getDuration = (blob: Blob): Promise<string> =>
  new Promise((ok, err) => {
    const a = document.createElement("audio");
    a.preload = "metadata";
    a.onloadedmetadata = () => ok(hhmmss(a.duration));
    a.onerror = () => err("Could not read duration");
    a.src = URL.createObjectURL(blob);
  });

/* ─────────────────  COMPONENT  ───────────────── */
export default function Home() {
  /* ----------  STATE  ---------- */
  const [file, setFile] = useState<File | null>(null);
  const [caseInfo, setCaseInfo] = useState<CaseInfo>({});
  const [specifySpeakers, setSpecifySpeakers] = useState(false);
  const [numSpeakers, setNumSpeakers] = useState(1);
  const [speakerNames, setSpeakerNames] = useState<string[]>([""]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [transcriptTurns, setTranscriptTurns] = useState<TranscriptTurn[] | null>(
    null
  );
  const [geminiFileName, setGeminiFileName] = useState<string | null>(null);
  const [r2ObjectKey, setR2ObjectKey] = useState<string | null>(null);
  const [audioDuration, setAudioDuration] = useState<string | null>(null);

  /* ----------  HELPERS  ---------- */
  const apiBase = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

  /* ----------  EVENT HANDLERS  ---------- */
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] || null;
    setFile(f);
    setTranscriptTurns(null);
    setError(null);
    setStatusMessage("");
    setGeminiFileName(null);
    setR2ObjectKey(null);
    setAudioDuration(null);
  };

  const handleCaseChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setCaseInfo((p) => ({ ...p, [name]: value }));
  };

  const changeNumSpeakers = (e: React.ChangeEvent<HTMLInputElement>) => {
    const n = Math.max(1, parseInt(e.target.value || "1", 10));
    setNumSpeakers(n);
    setSpeakerNames((prev) => {
      const out = [...prev];
      if (n > out.length) return [...out, ...Array(n - out.length).fill("")];
      return out.slice(0, n);
    });
  };

  const changeSpeakerName = (i: number, v: string) => {
    const arr = [...speakerNames];
    arr[i] = v.toUpperCase();
    setSpeakerNames(arr);
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!file) {
      setError("Choose a file first.");
      return;
    }

    setIsProcessing(true);
    setError(null);
    setStatusMessage("Creating secure upload…");

    try {
      /* 1️⃣  presign */
      const pre = await fetch(
        `${apiBase}/generate_r2_presigned?filename=${encodeURIComponent(
          file.name
        )}&content_type=${encodeURIComponent(file.type)}`,
        { method: "GET" }
      );
      if (!pre.ok) throw new Error(`presign ${pre.status}`);
      const { upload_url, object_key } = await pre.json();

      /* 2️⃣  upload */
      setStatusMessage("Uploading file…");
      const put = await fetch(upload_url, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!put.ok) throw new Error(`upload ${put.status}`);

      /* 3️⃣  request transcript */
      setStatusMessage("Requesting transcript…");
      const fd = new FormData();
      fd.append(
        "request_data_json",
        JSON.stringify({
          ...caseInfo,
          speaker_names: specifySpeakers
            ? speakerNames.filter((s) => s.trim())
            : null,
        })
      );
      fd.append("r2_object_key", object_key);
      const tr = await fetch(`${apiBase}/transcribe`, { method: "POST", body: fd });
      const tj = await tr.json();
      if (!tr.ok) throw new Error(tj.detail || tr.statusText);

      setTranscriptTurns(tj.transcript_turns);
      setGeminiFileName(tj.gemini_file_name);
      setR2ObjectKey(tj.r2_object_key || object_key);

      /* 4️⃣  duration */
      setStatusMessage("Calculating duration…");
      setAudioDuration(await getDuration(file));

      setStatusMessage("Transcription complete!");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setStatusMessage("");
    } finally {
      setIsProcessing(false);
    }
  };

  const cleanupFiles = async () => {
    if (!geminiFileName && !r2ObjectKey) return;
    setStatusMessage("Cleaning up…");
    try {
      if (geminiFileName && r2ObjectKey) {
        await fetch(
          `${apiBase}/cleanup/${geminiFileName}?r2_object_key=${r2ObjectKey}`,
          { method: "POST" }
        );
      } else if (geminiFileName) {
        await fetch(`${apiBase}/cleanup/${geminiFileName}`, { method: "POST" });
      } else if (r2ObjectKey) {
        await fetch(`${apiBase}/cleanup_r2/${r2ObjectKey}`, { method: "POST" });
      }
      setGeminiFileName(null);
      setR2ObjectKey(null);
      setStatusMessage("Temporary files deleted.");
    } catch {
      setStatusMessage("Cleanup attempted (see server logs for details).");
    }
  };

  const handleDownloadDocx = async () => {
    if (!transcriptTurns || !geminiFileName) {
      setError("Nothing to download.");
      return;
    }
    setIsProcessing(true);
    setStatusMessage("Generating DOCX…");
    try {
      const resp = await fetch(`${apiBase}/generate_docx`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gemini_file_name: geminiFileName,
          title_data: {
            ...caseInfo,
            FILE_NAME: file?.name || "file",
            FILE_DURATION: audioDuration || "N/A",
          },
          transcript_turns: transcriptTurns,
        }),
      });
      if (!resp.ok) {
        const d = await resp.json().catch(() => ({}));
        throw new Error(d.detail || resp.statusText);
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(file?.name.split(".")[0] || "transcript")}_transcript.docx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setStatusMessage("DOCX downloaded.");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg || "Download failed");
      setStatusMessage("");
    } finally {
      setIsProcessing(false);
    }
  };

  /* cleanup on unmount */
  useEffect(() => {
    return () => {
      if (geminiFileName || r2ObjectKey) cleanupFiles();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geminiFileName, r2ObjectKey]);

  /* ────────────────  RENDER  ──────────────── */
  return (
    <main className="flex min-h-screen flex-col items-center justify-start p-8 md:p-16 bg-gray-50">
      <div className="w-full max-w-4xl bg-white p-8 rounded-lg shadow-md">
        <h1 className="text-3xl font-bold mb-6 text-center text-gray-800">
          📄 Gemini Legal Transcript Generator (Next.js)
        </h1>
        <p className="mb-6 text-center text-gray-600">
          Upload an audio or video file to generate a transcript using the
          Gemini API.
        </p>

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* ────────── Case info ────────── */}
          <fieldset className="border p-4 rounded">
            <legend className="text-lg font-semibold px-2 text-gray-700">
              Case Information (Optional)
            </legend>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
              <input
                type="text"
                name="case_name"
                placeholder="Case Name"
                value={caseInfo.case_name || ""}
                onChange={handleCaseChange}
                className="border p-2 rounded w-full"
              />
              <input
                type="text"
                name="case_number"
                placeholder="Case Number"
                value={caseInfo.case_number || ""}
                onChange={handleCaseChange}
                className="border p-2 rounded w-full"
              />
              <input
                type="text"
                name="firm_name"
                placeholder="Firm / Organization"
                value={caseInfo.firm_name || ""}
                onChange={handleCaseChange}
                className="border p-2 rounded w-full"
              />
              <input
                type="date"
                name="input_date"
                value={caseInfo.input_date || ""}
                onChange={handleCaseChange}
                className="border p-2 rounded w-full"
              />
              <input
                type="time"
                name="input_time"
                value={caseInfo.input_time || ""}
                onChange={handleCaseChange}
                className="border p-2 rounded w-full"
              />
              <input
                type="text"
                name="location"
                placeholder="Location"
                value={caseInfo.location || ""}
                onChange={handleCaseChange}
                className="border p-2 rounded w-full"
              />
            </div>
          </fieldset>

          {/* ────────── Speaker info ────────── */}
          <fieldset className="border p-4 rounded">
            <legend className="text-lg font-semibold px-2 text-gray-700">
              Speaker Information (Optional)
            </legend>
            <div className="mt-2 space-y-3">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={specifySpeakers}
                  onChange={(e) => setSpecifySpeakers(e.target.checked)}
                  className="h-4 w-4 text-blue-600 border-gray-300 rounded"
                />
                <span className="text-gray-700">
                  Manually specify speaker identifiers?
                </span>
              </label>

              {specifySpeakers && (
                <>
                  <label className="flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-700">
                      Number of Speakers:
                    </span>
                    <input
                      type="number"
                      min="1"
                      value={numSpeakers}
                      onChange={changeNumSpeakers}
                      className="border p-1 rounded w-16 text-center"
                    />
                  </label>
                  <div className="space-y-2 pl-4">
                    {Array.from({ length: numSpeakers }).map((_, i) => (
                      <input
                        key={i}
                        type="text"
                        placeholder={`Speaker ${i + 1} Identifier (ALL CAPS)`}
                        value={speakerNames[i] || ""}
                        onChange={(e) => changeSpeakerName(i, e.target.value)}
                        className="border p-2 rounded w-full md:w-1/2 uppercase"
                        style={{ textTransform: "uppercase" }}
                      />
                    ))}
                  </div>
                </>
              )}
              {!specifySpeakers && (
                <p className="text-sm text-gray-500 pl-4">
                  Generic identifiers (SPEAKER 1, etc.) will be used.
                </p>
              )}
            </div>
          </fieldset>

          {/* ────────── File upload ────────── */}
          <div className="border p-4 rounded bg-gray-50">
            <label
              htmlFor="file-upload"
              className="block text-lg font-semibold mb-2 text-gray-700"
            >
              Upload Audio/Video File
            </label>
            <input
              id="file-upload"
              type="file"
              accept="audio/*,video/*"
              onChange={handleFileChange}
              className="block w-full text-sm text-gray-500
                        file:mr-4 file:py-2 file:px-4
                        file:rounded-full file:border-0
                        file:text-sm file:font-semibold
                        file:bg-blue-50 file:text-blue-700
                        hover:file:bg-blue-100"
            />
            {file && (
              <p className="text-sm text-gray-600 mt-2">
                Selected: {file.name} ({Math.round(file.size / 1024)} KB)
              </p>
            )}
          </div>

          {/* ────────── Submit ────────── */}
          <div className="text-center">
            <button
              type="submit"
              disabled={!file || isProcessing}
              className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-6 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition duration-150 ease-in-out"
            >
              {isProcessing ? "Processing…" : "Generate Transcript"}
            </button>
          </div>
        </form>

        {/* ────────── Status / Error ────────── */}
        <div className="mt-6 text-center min-h-[2em]">
          {isProcessing && (
            <p className="text-blue-600 animate-pulse">{statusMessage}</p>
          )}
          {error && <p className="text-red-600 font-semibold">Error: {error}</p>}
          {!isProcessing && !error && statusMessage && (
            <p className="text-green-600">{statusMessage}</p>
          )}
        </div>

        {/* ────────── Transcript display ────────── */}
        {transcriptTurns && (
          <div className="mt-8 border p-4 rounded bg-gray-50">
            <h2 className="text-xl font-semibold mb-4 text-gray-800">
              Generated Transcript
            </h2>
            {audioDuration && (
              <p className="text-sm text-gray-600 mb-2">
                Audio Duration: {audioDuration}
              </p>
            )}
            <textarea
              readOnly
              value={transcriptTurns
                .map((t) => `${t.speaker}:\t${t.text}`)
                .join("\n\n")}
              className="w-full h-64 p-2 border rounded bg-white font-mono text-sm"
            />
            <div className="text-center mt-4 space-y-3">
              <button
                onClick={handleDownloadDocx}
                disabled={isProcessing || !geminiFileName}
                className="bg-green-600 hover:bg-green-700 text-white font-bold py-2 px-4 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition duration-150 ease-in-out"
              >
                Download Transcript (.docx)
              </button>

              {(geminiFileName || r2ObjectKey) && (
                <div>
                  <button
                    onClick={cleanupFiles}
                    disabled={isProcessing}
                    className="bg-gray-500 hover:bg-gray-600 text-white font-bold py-2 px-4 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition duration-150 ease-in-out mt-2"
                  >
                    Clean Up Temporary Files
                  </button>
                  <p className="text-xs text-gray-500 mt-1">
                    Files are automatically removed when you leave the page.
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        <footer className="mt-8 text-center text-sm text-gray-500">
          Powered by Google Gemini & Next.js
        </footer>
      </div>
    </main>
  );
}