"use client"; // Required for useState, useEffect, useRef event handlers

import React, { useState, useRef, useEffect } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

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
  // State variables
  const [file, setFile] = useState<File | null>(null);
  const [caseInfo, setCaseInfo] = useState<CaseInfo>({});
  const [specifySpeakers, setSpecifySpeakers] = useState<boolean>(false);
  const [numSpeakers, setNumSpeakers] = useState<number>(1);
  const [speakerNames, setSpeakerNames] = useState<string[]>(['']); // Initialize with one empty speaker
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [transcriptTurns, setTranscriptTurns] = useState<TranscriptTurn[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [geminiFileName, setGeminiFileName] = useState<string | null>(null); // To store the Gemini file name for cleanup/docx
  const [audioDuration, setAudioDuration] = useState<string | null>(null); // To store calculated duration
  const [ffmpegLoaded, setFfmpegLoaded] = useState(false);
  const ffmpegRef = useRef(new FFmpeg());
  const messageRef = useRef<HTMLParagraphElement | null>(null); // For FFmpeg logs

  // --- FFmpeg Setup ---
  useEffect(() => {
    const loadFFmpeg = async () => {
      setStatusMessage("Loading FFmpeg assembly...");
      const ffmpeg = ffmpegRef.current;
      // Log progress
      ffmpeg.on('log', ({ message }) => {
        if (messageRef.current) messageRef.current.innerHTML = message;
        console.log(message);
      });
      // Base URL for loading ffmpeg-core.js, wasm etc.
      // Adjust this if your assets are hosted elsewhere
      const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';
      try {
        await ffmpeg.load({
          coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
          wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
        });
        setFfmpegLoaded(true);
        setStatusMessage("FFmpeg loaded.");
        console.log("FFmpeg loaded successfully.");
      } catch (err) {
        console.error("Error loading FFmpeg:", err);
        setError("Failed to load FFmpeg component. Video conversion unavailable.");
        setStatusMessage("");
      }
    };
    loadFFmpeg();
  }, []); // Load FFmpeg only once on component mount

  // --- Helper Functions ---
  const formatDuration = (seconds: number): string => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  // --- Event Handlers ---

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.target.files?.[0];
    if (selectedFile) {
      setFile(selectedFile);
      setTranscriptTurns(null); // Clear previous transcript
      setError(null);
      setStatusMessage('');
      setGeminiFileName(null);
      setAudioDuration(null); // Clear duration
      console.log("File selected:", selectedFile.name);
    }
  };

  const handleCaseInfoChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = event.target;
    setCaseInfo(prev => ({ ...prev, [name]: value }));
  };

  const handleSpeakerNameChange = (index: number, value: string) => {
    const updatedNames = [...speakerNames];
    updatedNames[index] = value.toUpperCase(); // Store as uppercase
    setSpeakerNames(updatedNames);
  };

  const handleNumSpeakersChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const count = parseInt(event.target.value, 10) || 1;
    setNumSpeakers(count);
    // Adjust speakerNames array size
    setSpeakerNames(prev => {
      const newNames = [...prev];
      if (count > newNames.length) {
        // Add empty strings if increasing
        return [...newNames, ...Array(count - newNames.length).fill('')];
      } else {
        // Truncate if decreasing
        return newNames.slice(0, count);
      }
    });
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!file) {
      setError("Please select a file first.");
      return;
    }

    setIsProcessing(true);
    setError(null);
    setTranscriptTurns(null);
    setStatusMessage("Starting process...");
    setGeminiFileName(null);
    setAudioDuration(null);

    let audioBlob: Blob | null = null;
    let calculatedDuration: string | null = null;
    const ffmpeg = ffmpegRef.current;

    try {
      // 1. Handle File Input & Conversion (if necessary)
      if (file.type.startsWith("video/")) {
        if (!ffmpegLoaded) {
          throw new Error("FFmpeg not loaded. Cannot convert video.");
        }
        setStatusMessage("Converting video to MP3 audio...");
        const inputFileName = `input.${file.name.split('.').pop() || 'mp4'}`;
        const outputFileName = "output.mp3";

        await ffmpeg.writeFile(inputFileName, await fetchFile(file));

        // Run FFmpeg command for conversion
        // Using -vn to remove video, -acodec libmp3lame for MP3, -ab 192k for bitrate
        // The '-i' flag specifies the input file.
        // We add '-async 1' to help with potential audio sync issues.
        // We add '-loglevel error' to reduce console noise, only showing errors.
        await ffmpeg.exec(['-i', inputFileName, '-vn', '-acodec', 'libmp3lame', '-ab', '192k', '-async', '1', '-loglevel', 'error', outputFileName]);

        setStatusMessage("Reading converted audio...");
        const data = await ffmpeg.readFile(outputFileName);

        // Get duration using ffprobe (run separately)
        // Need to write the *original* file again for ffprobe if it was deleted or overwritten
        // Or better: write original file first, run ffprobe, then run conversion
        await ffmpeg.writeFile(inputFileName, await fetchFile(file)); // Ensure input file exists for ffprobe
        let duration = 0;
        try {
            // Use ffprobe to get duration. '-show_entries format=duration' gets duration.
            // '-of default=noprint_wrappers=1:nokey=1' formats output to just the number.
            // '-v error' suppresses info messages.
            // Note: Capturing specific stdout here is tricky with current exec signature.
            // Relying on general logs or potential future library features.
            await ffmpeg.exec(['-i', inputFileName, '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', '-v', 'error', '-sexagesimal']);
        } catch (probeErr) {
            console.error("ffprobe failed:", probeErr);
            // Continue without duration if ffprobe fails
        }


        audioBlob = new Blob([data], { type: 'audio/mp3' });
        setStatusMessage("Video converted successfully.");

        // Optional: Clean up files in virtual FS
        // await ffmpeg.deleteFile(inputFileName);
        // await ffmpeg.deleteFile(outputFileName);

      } else if (file.type.startsWith("audio/")) {
        setStatusMessage("Processing audio file...");
        audioBlob = file; // Use original audio file directly

        // Try to get duration for audio files too
         if (ffmpegLoaded) {
            const inputFileName = `input.${file.name.split('.').pop() || 'mp3'}`;
            await ffmpeg.writeFile(inputFileName, await fetchFile(file));
            let duration = 0; // Keep duration calculation logic, but exec call changes
            try {
                 // Note: Capturing specific stdout here is tricky with current exec signature.
                 await ffmpeg.exec(['-i', inputFileName, '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', '-v', 'error', '-sexagesimal']);
                 // We might need to parse the general logs if duration appears there,
                 // or accept that duration calculation might be less reliable this way.
                 // For now, we proceed without guaranteed duration capture from this specific exec call.
            } catch (probeErr) {
                console.error("ffprobe failed for audio:", probeErr);
            }
            // await ffmpeg.deleteFile(inputFileName); // Optional cleanup
         } else {
             console.warn("FFmpeg not loaded, cannot calculate audio duration.");
         }

      } else {
        throw new Error(`Unsupported file type: ${file.type}`);
      }

      if (!audioBlob) {
        throw new Error("Audio processing failed.");
      }

      setAudioDuration(calculatedDuration); // Set duration state

      // 2. Prepare FormData
      setStatusMessage("Preparing data for upload...");
      const formData = new FormData();
      const requestData = {
        ...caseInfo,
        speaker_names: specifySpeakers ? speakerNames.filter(name => name && name.trim() !== '') : null,
      };
      formData.append('request_data_json', JSON.stringify(requestData));
      // Use a generic name for the blob, backend uses mime type anyway
      formData.append('audio_file', audioBlob, `processed_audio.mp3`); // Send as mp3

      // 3. Call backend /transcribe endpoint
      setStatusMessage("Uploading audio and requesting transcript...");
      // Use environment variable for API URL in production
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'; // Default to local FastAPI
      const response = await fetch(`${apiUrl}/transcribe`, {
        method: 'POST',
        body: formData,
        // Headers are automatically set for FormData
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ detail: response.statusText }));
        throw new Error(`API Error (${response.status}): ${errorData.detail || 'Unknown error'}`);
      }

      const result = await response.json();

      // 4. Handle response
      setTranscriptTurns(result.transcript_turns);
      setGeminiFileName(result.gemini_file_name); // Store for DOCX and cleanup
      setStatusMessage("Transcription complete!");
      console.log("Transcription successful:", result);

    } catch (err: any) {
      console.error("Error during submission:", err);
      setError(err.message || "An unexpected error occurred.");
      setStatusMessage(''); // Clear status on error
    } finally {
      setIsProcessing(false);
    }
  };

  const handleDownloadDocx = async () => {
    if (!transcriptTurns || !geminiFileName) {
      setError("No transcript available to download or missing file identifier.");
      return;
    }
    if (!transcriptTurns || !geminiFileName) {
      setError("No transcript available to download or missing file identifier.");
      return;
    }
    setError(null);
    setStatusMessage("Generating DOCX...");
    setIsProcessing(true); // Indicate activity

    try {
      // 1. Prepare title data
      const titleData = {
          ...caseInfo,
          FILE_NAME: file?.name || 'unknown_file',
          FILE_DURATION: audioDuration || "N/A", // Use stored duration
      };

      // 2. Call backend /generate_docx endpoint
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';
      const response = await fetch(`${apiUrl}/generate_docx`, {
          method: 'POST',
          headers: {
              'Content-Type': 'application/json',
          },
          body: JSON.stringify({
              gemini_file_name: geminiFileName, // Pass the stored name
              title_data: titleData,
              transcript_turns: transcriptTurns,
          }),
      });

      if (!response.ok) {
          const errorData = await response.json().catch(() => ({ detail: response.statusText }));
          throw new Error(`API Error (${response.status}): ${errorData.detail || 'Failed to generate DOCX'}`);
      }

      // 3. Handle the file stream response and trigger download
      const blob = await response.blob();
      const downloadUrl = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = downloadUrl;
      // Extract filename from content-disposition header if available, otherwise generate one
      const disposition = response.headers.get('content-disposition');
      let downloadFilename = `${file?.name.split('.')[0] || 'transcript'}_transcript.docx`; // Default
      if (disposition && disposition.indexOf('attachment') !== -1) {
          const filenameRegex = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/;
          const matches = filenameRegex.exec(disposition);
          if (matches != null && matches[1]) {
              downloadFilename = matches[1].replace(/['"]/g, '');
          }
      }
      link.setAttribute('download', downloadFilename);
      document.body.appendChild(link);
      link.click();
      link.parentNode?.removeChild(link);
      window.URL.revokeObjectURL(downloadUrl); // Clean up blob URL

      setStatusMessage("DOCX downloaded successfully.");

    } catch (err: any) {
        console.error("Error downloading DOCX:", err);
        setError(err.message || "Failed to download DOCX.");
        setStatusMessage('');
    } finally {
        setIsProcessing(false); // Stop indicating activity
    }
  };

  // --- Render Logic ---
  return (
    <main className="flex min-h-screen flex-col items-center justify-start p-8 md:p-16 bg-gray-50">
      <div className="w-full max-w-4xl bg-white p-8 rounded-lg shadow-md">
        <h1 className="text-3xl font-bold mb-6 text-center text-gray-800">
          📄 Gemini Legal Transcript Generator (Next.js)
        </h1>
        <p className="mb-6 text-center text-gray-600">
          Upload an audio or video file to generate a transcript using the Gemini API.
        </p>

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Case Information */}
          <fieldset className="border p-4 rounded">
            <legend className="text-lg font-semibold px-2 text-gray-700">Case Information (Optional)</legend>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
              <input type="text" name="case_name" placeholder="Case Name" value={caseInfo.case_name || ''} onChange={handleCaseInfoChange} className="border p-2 rounded w-full" />
              <input type="text" name="case_number" placeholder="Case Number" value={caseInfo.case_number || ''} onChange={handleCaseInfoChange} className="border p-2 rounded w-full" />
              <input type="text" name="firm_name" placeholder="Firm or Organization" value={caseInfo.firm_name || ''} onChange={handleCaseInfoChange} className="border p-2 rounded w-full" />
              <input type="date" name="input_date" placeholder="Date" value={caseInfo.input_date || ''} onChange={handleCaseInfoChange} className="border p-2 rounded w-full" />
              <input type="time" name="input_time" placeholder="Time" value={caseInfo.input_time || ''} onChange={handleCaseInfoChange} className="border p-2 rounded w-full" />
              <input type="text" name="location" placeholder="Location" value={caseInfo.location || ''} onChange={handleCaseInfoChange} className="border p-2 rounded w-full" />
            </div>
          </fieldset>

          {/* Speaker Information */}
          <fieldset className="border p-4 rounded">
            <legend className="text-lg font-semibold px-2 text-gray-700">Speaker Information (Optional)</legend>
            <div className="mt-2 space-y-3">
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="specifySpeakers"
                  checked={specifySpeakers}
                  onChange={(e) => setSpecifySpeakers(e.target.checked)}
                  className="h-4 w-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                />
                <label htmlFor="specifySpeakers" className="text-gray-700">Manually specify speaker identifiers?</label>
              </div>

              {specifySpeakers && (
                <>
                  <div className="flex items-center gap-2">
                    <label htmlFor="numSpeakers" className="text-sm font-medium text-gray-700">Number of Speakers:</label>
                    <input
                      type="number"
                      id="numSpeakers"
                      min="1"
                      value={numSpeakers}
                      onChange={handleNumSpeakersChange}
                      className="border p-1 rounded w-16 text-center"
                    />
                  </div>
                  <div className="space-y-2 pl-4">
                    {Array.from({ length: numSpeakers }).map((_, index) => (
                      <input
                        key={index}
                        type="text"
                        placeholder={`Speaker ${index + 1} Identifier (ALL CAPS)`}
                        value={speakerNames[index] || ''}
                        onChange={(e) => handleSpeakerNameChange(index, e.target.value)}
                        className="border p-2 rounded w-full md:w-1/2 uppercase" // Enforce uppercase visually
                        style={{ textTransform: 'uppercase' }} // CSS uppercase
                      />
                    ))}
                  </div>
                </>
              )}
               {!specifySpeakers && (
                 <p className="text-sm text-gray-500 pl-4">Generic identifiers (SPEAKER 1, SPEAKER 2, etc.) will be used.</p>
               )}
            </div>
          </fieldset>

          {/* File Upload */}
          <div className="border p-4 rounded bg-gray-50">
             <label htmlFor="file-upload" className="block text-lg font-semibold mb-2 text-gray-700">Upload Audio/Video File</label>
             <input
               id="file-upload"
               type="file"
               onChange={handleFileChange}
               accept="audio/*,video/*" // Accept common audio/video types
               className="block w-full text-sm text-gray-500
                          file:mr-4 file:py-2 file:px-4
                          file:rounded-full file:border-0
                          file:text-sm file:font-semibold
                          file:bg-blue-50 file:text-blue-700
                          hover:file:bg-blue-100"
             />
             {file && <p className="text-sm text-gray-600 mt-2">Selected: {file.name} ({Math.round(file.size / 1024)} KB)</p>}
          </div>

          {/* Submit Button */}
          <div className="text-center">
            <button
              type="submit"
              disabled={!file || isProcessing}
              className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-6 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition duration-150 ease-in-out"
            >
              {isProcessing ? 'Processing...' : 'Generate Transcript'}
            </button>
          </div>
        </form>

        {/* Status & Error Display */}
        <div className="mt-6 text-center min-h-[2em]"> {/* Added min-height */}
          {isProcessing && (
            <div>
                <p className="text-blue-600 animate-pulse">{statusMessage || 'Processing...'}</p>
                {/* FFmpeg log display area */}
                <p ref={messageRef} className="text-sm text-gray-500 mt-1 font-mono"></p>
            </div>
          )}
          {error && <p className="text-red-600 font-semibold">Error: {error}</p>}
          {!isProcessing && !error && statusMessage && <p className="text-green-600">{statusMessage}</p>}
        </div>

        {/* Transcript Display */}
        {transcriptTurns && transcriptTurns.length > 0 && (
          <div className="mt-8 border p-4 rounded bg-gray-50">
            <h2 className="text-xl font-semibold mb-4 text-gray-800">Generated Transcript</h2>
            {audioDuration && <p className="text-sm text-gray-600 mb-2">Audio Duration: {audioDuration}</p>}
            <textarea
              readOnly
              value={transcriptTurns.map(turn => `${turn.speaker}:\t${turn.text}`).join('\n\n')}
              className="w-full h-64 p-2 border rounded bg-white font-mono text-sm" // Monospace font for alignment
            />
            <div className="text-center mt-4">
               <button
                 onClick={handleDownloadDocx}
                 disabled={isProcessing || !geminiFileName} // Also disable if no geminiFileName
                 className="bg-green-600 hover:bg-green-700 text-white font-bold py-2 px-4 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition duration-150 ease-in-out"
               >
                 Download Transcript (.docx)
               </button>
            </div>
          </div>
        )}

        <footer className="mt-8 text-center text-sm text-gray-500">
          Powered by Google Gemini & Next.js
        </footer>
      </div>
    </main>
  );
}
