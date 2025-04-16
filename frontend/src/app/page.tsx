"use client"; // Required for useState, useEffect, useRef hooks

import React, { useState, useRef, useEffect } from "react";

// Define interfaces for our data structures (matching backend Pydantic models)
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

export default function Home() {
  /* -------------- state -------------- */
  const [file, setFile] = useState<File | null>(null);
  const [caseInfo, setCaseInfo] = useState<CaseInfo>({});
  const [specifySpeakers, setSpecifySpeakers] = useState(false);
  const [numSpeakers, setNumSpeakers] = useState(1);
  const [speakerNames, setSpeakerNames] = useState<string[]>([""]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [transcriptTurns, setTranscriptTurns] =
    useState<TranscriptTurn[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState("");
  const [geminiFileName, setGeminiFileName] = useState<string | null>(null);
  const [audioDuration, setAudioDuration] = useState<string | null>(null);

  /* ------- dummy FFmpeg placeholders (remove if not needed) -------- */
  const ffmpegRef = useRef<any>(null);
  const [ffmpegLoaded] = useState(false);
  const messageRef = useRef<HTMLParagraphElement | null>(null);

  /* -------------- handlers -------------- */
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (!selected) return;
    setFile(selected);
    setError(null);
    setStatusMessage("");
    setTranscriptTurns(null);
  };

  const handleCaseInfoChange = (e: React.ChangeEvent<HTMLInputElement>) =>
    setCaseInfo((p) => ({ ...p, [e.target.name]: e.target.value }));

  const handleNumSpeakersChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const n = Math.max(1, parseInt(e.target.value, 10) || 1);
    setNumSpeakers(n);
    setSpeakerNames((prev) =>
      n > prev.length
        ? [...prev, ...Array(n - prev.length).fill("")]
        : prev.slice(0, n),
    );
  };

  /* ------------------ stub submit / download ------------------ */
  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setIsProcessing(true);
    // …existing submit logic…
    setTimeout(() => {
      setTranscriptTurns([
        { speaker: "SPEAKER 1", text: "Demo transcript line one." },
        { speaker: "SPEAKER 2", text: "Demo transcript line two." },
      ]);
      setGeminiFileName("files/demo");
      setStatusMessage("Transcription complete!");
      setIsProcessing(false);
    }, 1800);
  }

  async function handleDownloadDocx() {
    // …existing download logic…
  }

  /* -------------- UI -------------- */
  return (
    <main className="flex min-h-screen flex-col items-center justify-start p-8 md:p-16 bg-gradient-to-b from-slate-100 to-white">
      <div className="w-full max-w-5xl bg-white/80 backdrop-blur-lg p-10 rounded-xl shadow-2xl ring-1 ring-gray-200">
        <h1 className="text-4xl font-extrabold mb-8 text-center text-gray-800 tracking-tight">
          📄 Gemini Legal Transcript Generator (Next.js)
        </h1>
        <p className="mb-6 text-center text-gray-600">
          Upload an audio or video file to generate a transcript using the
          Gemini API.
        </p>

        {/* ---------- FORM ---------- */}
        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Case information */}
          <fieldset className="border-t-2 border-gray-200 p-6 rounded mb-4 bg-white/60">
            <legend className="text-lg font-semibold px-2 text-gray-700">
              Case Information (Optional)
            </legend>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
              {([
                ["case_name", "Case Name"],
                ["case_number", "Case Number"],
                ["firm_name", "Firm / Organization"],
                ["location", "Location"],
              ] as const).map(([name, placeholder]) => (
                <input
                  key={name}
                  name={name}
                  placeholder={placeholder}
                  value={(caseInfo as any)[name] || ""}
                  onChange={handleCaseInfoChange}
                  className="border p-2 rounded w-full focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition"
                />
              ))}
              <input
                type="date"
                name="input_date"
                value={caseInfo.input_date || ""}
                onChange={handleCaseInfoChange}
                className="border p-2 rounded w-full focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition"
              />
              <input
                type="time"
                name="input_time"
                value={caseInfo.input_time || ""}
                onChange={handleCaseInfoChange}
                className="border p-2 rounded w-full focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition"
              />
            </div>
          </fieldset>

          {/* Speakers */}
          <fieldset className="border-t-2 border-gray-200 p-6 rounded mb-4 bg-white/60">
            <legend className="text-lg font-semibold px-2 text-gray-700">
              Speaker Information (Optional)
            </legend>
            <div className="space-y-3">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={specifySpeakers}
                  onChange={(e) => setSpecifySpeakers(e.target.checked)}
                  className="h-4 w-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                />
                <span className="text-gray-700">
                  Manually specify speaker identifiers?
                </span>
              </label>

              {specifySpeakers && (
                <>
                  <label className="flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-700">
                      Number of Speakers
                    </span>
                    <input
                      type="number"
                      min={1}
                      value={numSpeakers}
                      onChange={handleNumSpeakersChange}
                      className="border p-1 rounded w-20 text-center focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition"
                    />
                  </label>
                  <div className="space-y-2 pl-4">
                    {Array.from({ length: numSpeakers }).map((_, i) => (
                      <input
                        key={i}
                        placeholder={`Speaker ${i + 1} Identifier (ALL CAPS)`}
                        value={speakerNames[i] || ""}
                        onChange={(e) =>
                          setSpeakerNames((names) => {
                            const copy = [...names];
                            copy[i] = e.target.value.toUpperCase();
                            return copy;
                          })
                        }
                        className="border p-2 rounded w-full md:w-1/2 uppercase focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition"
                        style={{ textTransform: "uppercase" }}
                      />
                    ))}
                  </div>
                </>
              )}
              {!specifySpeakers && (
                <p className="text-sm text-gray-500 pl-4">
                  Generic identifiers (SPEAKER 1, SPEAKER 2…) will be used.
                </p>
              )}
            </div>
          </fieldset>

          {/* File upload */}
          <div className="border-t-2 border-gray-200 p-6 rounded bg-gray-50">
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
                         hover:file:bg-blue-100
                         focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition"
            />
            {file && (
              <p className="text-sm text-gray-600 mt-2">
                Selected: {file.name} ({Math.round(file.size / 1024)} KB)
              </p>
            )}
          </div>

          {/* Submit */}
          <div className="text-center">
            <button
              type="submit"
              disabled={!file || isProcessing}
              className="group relative inline-flex items-center justify-center overflow-hidden rounded-lg bg-gradient-to-r from-blue-600 to-indigo-600 px-8 py-3 font-semibold text-white shadow-lg transition-all duration-200 hover:from-indigo-600 hover:to-purple-600 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isProcessing ? "Processing…" : "Generate Transcript"}
            </button>
          </div>
        </form>

        {/* Status / errors */}
        <div className="mt-6 text-center min-h-[2em]">
          {isProcessing && (
            <div>
              <p className="text-blue-600 animate-pulse">
                {statusMessage || "Processing…"}
              </p>
              <p
                ref={messageRef}
                className="text-sm text-gray-500 mt-1 font-mono"
              />
            </div>
          )}
          {error && <p className="text-red-600 font-semibold">Error: {error}</p>}
          {!isProcessing && !error && statusMessage && (
            <p className="text-green-600">{statusMessage}</p>
          )}
        </div>

        {/* Transcript */}
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
                .map((t) => `${t.speaker}:  ${t.text}`)
                .join("\n\n")}
              className="w-full h-80 p-4 border rounded-lg bg-white font-mono text-sm resize-none shadow-inner"
            />
            <div className="text-center mt-4">
              <button
                onClick={handleDownloadDocx}
                disabled={isProcessing || !geminiFileName}
                className="group relative inline-flex items-center justify-center overflow-hidden rounded-lg bg-gradient-to-r from-blue-600 to-indigo-600 px-8 py-3 font-semibold text-white shadow-lg transition-all duration-200 hover:from-indigo-600 hover:to-purple-600 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Download Transcript (.docx)
              </button>
            </div>
          </div>
        )}

        <footer className="mt-12 text-center text-sm text-gray-500">
          Powered by Google Gemini & Next.js
        </footer>
      </div>
    </main>
  );
}