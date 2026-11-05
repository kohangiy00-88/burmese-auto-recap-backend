
import "dotenv/config";

import express from "express";
import cors from "cors";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { GoogleGenAI } from "@google/genai";

import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

/* =========================================================
   HWA EDITOR · BURMESE MOVIE RECAP
   Backend Version: 6.2.0
   ========================================================= */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const PORT = Number(process.env.PORT || 10000);

const UPLOAD_DIR = path.join(__dirname, "uploads");
const OUTPUT_DIR = path.join(__dirname, "outputs");
const TEMP_DIR = path.join(__dirname, "temp");

/* -------------------------
   BASIC CONFIGURATION
------------------------- */

const MAX_UPLOAD_SIZE = 1024 * 1024 * 1024;
const MAX_VIDEO_DURATION = 350 * 60;

// Analyze long movies in smaller clips.
// 15 minutes per Gemini request.
const RECAP_CHUNK_SECONDS = 15 * 60;

// Gemini TTS input model.
// IMPORTANT: No Pro TTS fallback.
const TTS_MODEL = "gemini-2.5-flash-preview-tts";

const TTS_VOICE = process.env.GEMINI_TTS_VOICE || "Kore";

const RECAP_MODEL =
  process.env.GEMINI_RECAP_MODEL || "gemini-2.5-flash";

/* -------------------------
   DIRECTORIES
------------------------- */

await Promise.all([
  fsp.mkdir(UPLOAD_DIR, { recursive: true }),
  fsp.mkdir(OUTPUT_DIR, { recursive: true }),
  fsp.mkdir(TEMP_DIR, { recursive: true })
]);

/* -------------------------
   FFMPEG CONFIGURATION
------------------------- */

if (ffmpegStatic) {
  ffmpeg.setFfmpegPath(ffmpegStatic);
}

if (ffprobeStatic?.path) {
  ffmpeg.setFfprobePath(ffprobeStatic.path);
}

/* -------------------------
   EXPRESS CONFIGURATION
------------------------- */

app.set("trust proxy", 1);

app.use(
  cors({
    origin: true,
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"]
  })
);

app.use(express.json({ limit: "5mb" }));

app.use(
  "/outputs",
  express.static(OUTPUT_DIR, {
    maxAge: "1h",
    setHeaders(res) {
      res.setHeader("Accept-Ranges", "bytes");
    }
  })
);

/* -------------------------
   MEMORY JOB DATABASE
------------------------- */

const jobs = new Map();

let geminiClient = null;

function getGemini() {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error(
      "Render Environment ထဲမှာ GEMINI_API_KEY မထည့်ရသေးပါ။"
    );
  }

  if (!geminiClient) {
    geminiClient = new GoogleGenAI({
      apiKey
    });
  }

  return geminiClient;
}

/* =========================================================
   GENERAL HELPERS
========================================================= */

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function getPublicUrl(req, filePath) {
  return `${req.protocol}://${req.get("host")}${filePath}`;
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  const types = {
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".mov": "video/quicktime",
    ".avi": "video/x-msvideo",
    ".webm": "video/webm",
    ".wmv": "video/x-ms-wmv",
    ".3gp": "video/3gpp",
    ".mpeg": "video/mpeg",
    ".mpg": "video/mpeg"
  };

  return types[ext] || "application/octet-stream";
}

function getJob(jobId) {
  const job = jobs.get(jobId);

  if (!job) {
    const error = new Error(
      "ဒီ Video Job ကို မတွေ့ပါ။ Upload ပြန်လုပ်ပေးပါ။"
    );

    error.status = 404;
    throw error;
  }

  return job;
}

function getPublicJob(job, req) {
  return {
    id: job.id,
    originalName: job.originalName,
    size: job.size,
    duration: job.duration,

    status: job.status,
    progress: job.progress,
    step: job.step,

    recapScript: job.recapScript || "",

    segments: (job.segments || []).map(segment => ({
      start: segment.start,
      end: segment.end,
      narration: segment.narration
    })),

    voiceUrl: job.voiceUrl
      ? getPublicUrl(req, job.voiceUrl)
      : null,

    outputUrl: job.outputUrl
      ? getPublicUrl(req, job.outputUrl)
      : null,

    error: job.error || null
  };
}

function updateProgress(job, progress, step) {
  job.progress = Math.max(
    0,
    Math.min(100, Math.round(progress))
  );

  job.step = step;
  job.updatedAt = Date.now();
}

function getErrorText(error) {
  try {
    return [
      error?.message || "",
      error?.status || "",
      error?.code || "",
      JSON.stringify(error)
    ].join(" ");
  } catch {
    return String(error);
  }
}

function getErrorStatus(error) {
  return Number(
    error?.status ||
    error?.response?.status ||
    error?.codeNumber ||
    0
  );
}

function isQuotaExceeded(error) {
  const text = getErrorText(error).toLowerCase();

  return (
    text.includes("resource_exhausted") ||
    text.includes("limit: 0") ||
    text.includes("exceeded your current quota") ||
    text.includes("quota exceeded") ||
    text.includes("billing")
  );
}

function formatApiError(error) {
  const status = getErrorStatus(error);

  if (isQuotaExceeded(error)) {
    return (
      "Google Gemini API ရဲ့ Quota/Billing ကန့်သတ်ချက်ကြောင့် " +
      "မြန်မာ AI Voice မထုတ်နိုင်ပါ။ " +
      "ဒီ Backend က Pro မော်ဒယ်ကို ပြောင်းမခေါ်ပါ။ " +
      "Google AI Studio မှာ Flash TTS ရဲ့ Quota နဲ့ Billing ကို စစ်ပါ။"
    );
  }

  if (status === 429) {
    return (
      "Gemini Flash TTS ကို ခဏအတွင်း Request များလွန်းလို့ " +
      "ယာယီကန့်သတ်ထားပါတယ်။ ခဏနားပြီး ပြန်လုပ်ပါ။"
    );
  }

  if (status === 503) {
    return (
      "Gemini Flash TTS Server ယာယီအလုပ်များနေပါတယ်။ " +
      "ပြန်လည်ကြိုးစားပါ။"
    );
  }

  return (
    error?.message ||
    "AI ဝန်ဆောင်မှုမှာ မသိရသေးတဲ့ အမှားဖြစ်နေပါတယ်။"
  );
}

/* =========================================================
   FFMPEG / FFPROBE HELPERS
========================================================= */

function probeMedia(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (error, metadata) => {
      if (error) {
        return reject(error);
      }

      resolve(metadata);
    });
  });
}

async function getMediaDuration(filePath) {
  const metadata = await probeMedia(filePath);

  const videoStream = metadata.streams?.find(
    stream => stream.codec_type === "video"
  );

  if (!videoStream) {
    throw new Error(
      "Video Stream မတွေ့ပါ။ Video ဖိုင်မှန်မမှန် စစ်ပါ။"
    );
  }

  const duration = safeNumber(
    metadata.format?.duration ||
    videoStream.duration,
    0
  );

  if (!duration || duration <= 0) {
    throw new Error(
      "Video ကြာချိန်ကို မဖတ်နိုင်ပါ။"
    );
  }

  return duration;
}

/* =========================================================
   FILE UPLOAD
========================================================= */

const storage = multer.diskStorage({
  destination(req, file, callback) {
    callback(null, UPLOAD_DIR);
  },

  filename(req, file, callback) {
    const id = crypto.randomUUID();

    const ext = path.extname(file.originalname)
      .toLowerCase()
      .replace(/[^a-z0-9.]/g, "");

    callback(null, `${id}${ext || ".mp4"}`);
  }
});

const allowedExtensions = new Set([
  ".mp4",
  ".m4v",
  ".mov",
  ".avi",
  ".webm",
  ".wmv",
  ".3gp",
  ".mpeg",
  ".mpg"
]);

const upload = multer({
  storage,

  limits: {
    fileSize: MAX_UPLOAD_SIZE
  },

  fileFilter(req, file, callback) {
    const ext = path.extname(file.originalname).toLowerCase();

    if (!allowedExtensions.has(ext)) {
      return callback(
        new Error(
          "MP4, MOV, AVI, WEBM, WMV, 3GP, MPEG ဖိုင်များသာ လက်ခံပါတယ်။"
        )
      );
    }

    callback(null, true);
  }
});

/* =========================================================
   API HEALTH CHECK
========================================================= */

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    status: "OK",
    version: "6.2.0",

    models: {
      recap: RECAP_MODEL,
      voice: TTS_MODEL,
      voiceName: TTS_VOICE
    },

    limits: {
      maxUploadBytes: MAX_UPLOAD_SIZE,
      maxDurationSeconds: MAX_VIDEO_DURATION
    }
  });
});

/* =========================================================
   UPLOAD VIDEO
========================================================= */

app.post(
  "/api/upload",
  upload.single("video"),
  async (req, res) => {
    let filePath = null;

    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: "Video ဖိုင်ကို ရွေးချယ်ပေးပါ။"
        });
      }

      filePath = req.file.path;

      const duration = await getMediaDuration(filePath);

      if (duration > MAX_VIDEO_DURATION) {
        await fsp.unlink(filePath).catch(() => {});

        return res.status(400).json({
          success: false,
          error:
            "Video ကြာချိန်က ၃၅၀ မိနစ်ထက် ကျော်နေပါတယ်။"
        });
      }

      const id = path.basename(
        filePath,
        path.extname(filePath)
      );

      const job = {
        id,

        originalName: req.file.originalname,
        filePath,
        size: req.file.size,

        mimeType: getMimeType(filePath),
        duration,

        status: "uploaded",
        progress: 0,
        step: "Video Upload အောင်မြင်ပါပြီ။",

        recapScript: "",
        segments: [],

        voiceSegments: [],
        voiceUrl: null,
        outputUrl: null,

        error: null,
        busy: false,

        createdAt: Date.now(),
        updatedAt: Date.now()
      };

      jobs.set(id, job);

      res.json({
        success: true,

        message: "Video Upload အောင်မြင်ပါပြီ။",

        jobId: id,

        file: {
          name: req.file.originalname,
          size: req.file.size,
          duration
        },

        job: getPublicJob(job, req)
      });

    } catch (error) {
      if (filePath) {
        await fsp.unlink(filePath).catch(() => {});
      }

      console.error("UPLOAD ERROR:", error);

      res.status(400).json({
        success: false,
        error: error.message || "Video Upload မအောင်မြင်ပါ။"
      });
    }
  }
);

/* =========================================================
   GEMINI FILE API
========================================================= */

async function waitForGeminiFile(file, ai) {
  let currentFile = file;

  const started = Date.now();
  const maximumWait = 30 * 60 * 1000;

  while (true) {
    const state = String(
      currentFile.state || ""
    ).toUpperCase();

    if (state === "ACTIVE") {
      return currentFile;
    }

    if (state === "FAILED") {
      throw new Error(
        currentFile.error?.message ||
        "Gemini Video File Processing မအောင်မြင်ပါ။"
      );
    }

    if (Date.now() - started > maximumWait) {
      throw new Error(
        "Gemini Video Processing အချိန်ကြာလွန်းနေပါတယ်။"
      );
    }

    await sleep(5000);

    currentFile = await ai.files.get({
      name: currentFile.name
    });
  }
}

/* =========================================================
   RECAP JSON HELPERS
========================================================= */

function responseToText(response) {
  try {
    const value = response.text;

    if (typeof value === "function") {
      return value.call(response) || "";
    }

    if (typeof value === "string") {
      return value;
    }
  } catch {
    // Continue to candidate parsing.
  }

  const parts =
    response?.candidates?.[0]?.content?.parts || [];

  return parts
    .filter(part => typeof part.text === "string")
    .map(part => part.text)
    .join("\n");
}

function parseJsonResponse(rawText) {
  if (!rawText || !rawText.trim()) {
    throw new Error(
      "Gemini က Recap စာသား မပြန်ပေးပါ။"
    );
  }

  let text = rawText.trim();

  text = text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "");

  try {
    return JSON.parse(text);
  } catch {
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");

    if (first < 0 || last <= first) {
      throw new Error(
        "Recap JSON ကို ဖတ်မရပါ။ Gemini Response ကို စစ်ပါ။"
      );
    }

    return JSON.parse(
      text.slice(first, last + 1)
    );
  }
}

function parseTimestamp(value) {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value !== "string") {
    return NaN;
  }

  const text = value.trim();

  if (text.includes(":")) {
    const parts = text.split(":").map(Number);

    if (parts.some(item => !Number.isFinite(item))) {
      return NaN;
    }

    if (parts.length === 3) {
      return (
        parts[0] * 3600 +
        parts[1] * 60 +
        parts[2]
      );
    }

    if (parts.length === 2) {
      return parts[0] * 60 + parts[1];
    }
  }

  return Number.parseFloat(text);
}

function normalizeRecapSegments(
  data,
  chunkStart,
  chunkEnd
) {
  const rawSegments = Array.isArray(data)
    ? data
    : data?.segments;

  if (!Array.isArray(rawSegments)) {
    throw new Error(
      "Recap Response ထဲမှာ segments မတွေ့ပါ။"
    );
  }

  const chunkDuration = chunkEnd - chunkStart;

  const result = [];

  for (const item of rawSegments) {
    const rawStart = parseTimestamp(
      item.start ?? item.start_time
    );

    const rawEnd = parseTimestamp(
      item.end ?? item.end_time
    );

    const narration = String(
      item.narration ??
      item.voiceover ??
      item.script ??
      item.text ??
      ""
    ).trim();

    if (
      !Number.isFinite(rawStart) ||
      !Number.isFinite(rawEnd) ||
      !narration
    ) {
      continue;
    }

    // Gemini may return relative or absolute timestamps.
    let start = rawStart;
    let end = rawEnd;

    if (
      chunkStart > 0 &&
      rawStart >= chunkStart - 1 &&
      rawStart <= chunkEnd + 1
    ) {
      start = rawStart;
      end = rawEnd;
    } else {
      start = chunkStart + rawStart;
      end = chunkStart + rawEnd;
    }

    start = Math.max(chunkStart, start);
    end = Math.min(chunkEnd, end);

    if (end <= start || end - start < 0.5) {
      continue;
    }

    result.push({
      start,
      end,
      narration
    });
  }

  result.sort((a, b) => a.start - b.start);

  if (!result.length) {
    throw new Error(
      "Gemini Response ထဲမှာ အသုံးပြုနိုင်တဲ့ Recap Segment မတွေ့ပါ။"
    );
  }

  return result;
}

/* =========================================================
   RECAP PROMPT
========================================================= */

function createRecapPrompt(chunkStart, chunkEnd) {
  return `
သင်သည် မြန်မာ Movie Recap Script Writer တစ်ယောက်ဖြစ်သည်။

ပေးထားသော Movie Video အပိုင်းကို သေချာလေ့လာပြီး
သဘာဝကျသော မြန်မာဘာသာ Recap Script ရေးပါ။

အပိုင်းအချိန်:
${chunkStart} seconds မှ ${chunkEnd} seconds အထိ။

အရေးကြီးသော စည်းမျဉ်းများ -

၁။ ဗီဒီယိုထဲတွင် အမှန်တကယ် ဖြစ်ပျက်သော အကြောင်းအရာကိုသာ ရေးပါ။
၂။ မရှိသော ဇာတ်ဝင်ခန်း၊ ဇာတ်ကောင်၊ စကားပြောခန်းကို မဖန်တီးပါနှင့်။
၃။ ဇာတ်လမ်းအစဉ်လိုက် ရေးပါ။
၄။ အဓိကဇာတ်ကောင်များ၏ လုပ်ရပ်၊ ရည်ရွယ်ချက်နှင့် ဆက်ဆံရေးကို ရှင်းပြပါ။
၅။ အရေးကြီးသော စကားပြောခန်းများ၏ အဓိပ္ပာယ်ကို မြန်မာလို သဘာဝကျကျ ပြန်လည်ရှင်းပြပါ။
၆။ ရှည်လျားသော မူရင်း Dialogue ကို တိုက်ရိုက်မကူးပါနှင့်။
၇။ အရေးကြီးသော အဖြစ်အပျက်၊ အလှည့်အပြောင်းနှင့် Conflict များ မကျန်စေရ။
၈။ ဇာတ်လမ်းကို အလွန်အကျွံ ချုံ့မပစ်ပါနှင့်။
၉။ မြန်မာစကားပြောသံ သဘာဝကျပြီး YouTube Movie Recap Narration အတွက် သင့်တော်ရမည်။
၁၀။ အင်္ဂလိပ်စာ မသုံးပါနှင့်။ ဇာတ်ကောင်အမည်များကို လိုအပ်သလို အသံထွက်အတိုင်း ရေးနိုင်သည်။
၁၁။ ဤ Video အပိုင်း၏ အချိန်နှင့် ကိုက်ညီသော Scene များကိုသာ ရေးပါ။
၁၂။ Timestamp များကို ဤအပိုင်း၏ အစမှ စတင်သည့် Relative Seconds အဖြစ် ရေးပါ။
၁၃။ Segment တစ်ခုစီတွင် ရှင်းလင်းသော Narration ပါရမည်။
၁၄။ Segment တစ်ခုစီ၏ Narration သည် အများအားဖြင့် စာကြောင်း ၂ မှ ၅ ကြောင်းခန့် ဖြစ်ပါစေ။
၁၅။ ဇာတ်လမ်းအဆုံးကို မခန့်မှန်းပါနှင့်။

အောက်ပါ JSON ပုံစံအတိုင်းသာ ပြန်ပေးပါ။

{
  "segments": [
    {
      "start": 0,
      "end": 25,
      "narration": "မြန်မာလို Recap စာသား"
    }
  ]
}

JSON အပြင် အခြားရှင်းလင်းချက် မထည့်ပါနှင့်။
`;
}

/* =========================================================
   RECAP VIDEO
========================================================= */

app.post(
  "/api/jobs/:id/recap",
  async (req, res) => {
    const job = getJob(req.params.id);

    if (job.busy) {
      return res.status(409).json({
        success: false,
        error: "ဒီ Video ကို လုပ်ဆောင်နေပြီး ဖြစ်ပါတယ်။"
      });
    }

    job.busy = true;
    job.status = "recapping";
    job.error = null;

    let uploadedGeminiFile = null;

    try {
      const ai = getGemini();

      updateProgress(
        job,
        0,
        "Gemini ဆီ Video Upload လုပ်နေပါတယ်။"
      );

      uploadedGeminiFile = await ai.files.upload({
        file: job.filePath,

        config: {
          mimeType: job.mimeType,
          displayName: job.originalName
        }
      });

      updateProgress(
        job,
        5,
        "Gemini Video Processing လုပ်နေပါတယ်။"
      );

      uploadedGeminiFile = await waitForGeminiFile(
        uploadedGeminiFile,
        ai
      );

      const allSegments = [];

      const totalChunks = Math.ceil(
        job.duration / RECAP_CHUNK_SECONDS
      );

      for (
        let chunkIndex = 0;
        chunkIndex < totalChunks;
        chunkIndex++
      ) {
        const chunkStart =
          chunkIndex * RECAP_CHUNK_SECONDS;

        const chunkEnd = Math.min(
          job.duration,
          chunkStart + RECAP_CHUNK_SECONDS
        );

        updateProgress(
          job,
          10 + (chunkIndex / totalChunks) * 80,
          `Movie အပိုင်း ${chunkIndex + 1}/${totalChunks} ကို Recap ရေးနေပါတယ်။`
        );

        const response = await ai.models.generateContent({
          model: RECAP_MODEL,

          contents: [
            {
              role: "user",

              parts: [
                {
                  fileData: {
                    fileUri: uploadedGeminiFile.uri,
                    mimeType:
                      uploadedGeminiFile.mimeType ||
                      job.mimeType
                  },

                  videoMetadata: {
                    startOffset: `${chunkStart}s`,
                    endOffset: `${chunkEnd}s`
                  }
                },

                {
                  text: createRecapPrompt(
                    chunkStart,
                    chunkEnd
                  )
                }
              ]
            }
          ],

          config: {
            responseMimeType: "application/json",
            temperature: 0.2,
            maxOutputTokens: 8192
          }
        });

        const rawText = responseToText(response);

        const parsed = parseJsonResponse(rawText);

        const chunkSegments =
          normalizeRecapSegments(
            parsed,
            chunkStart,
            chunkEnd
          );

        allSegments.push(...chunkSegments);

        // Small pause between recap requests.
        await sleep(1200);
      }

      if (!allSegments.length) {
        throw new Error(
          "အသုံးပြုနိုင်သော Recap စာသား မတွေ့ပါ။"
        );
      }

      allSegments.sort((a, b) => a.start - b.start);

      const hasMyanmar = allSegments.some(segment =>
        /[\u1000-\u109F]/.test(segment.narration)
      );

      if (!hasMyanmar) {
        throw new Error(
          "မြန်မာဘာသာ Recap စာသား မရရှိပါ။"
        );
      }

      job.segments = allSegments;

      job.recapScript = allSegments
        .map(segment => segment.narration)
        .join("\n\n");

      job.status = "recap_done";

      updateProgress(
        job,
        100,
        "မြန်မာ Movie Recap အောင်မြင်ပါပြီ။"
      );

      res.json({
        success: true,
        message: "မြန်မာ Movie Recap အောင်မြင်ပါပြီ။",

        recapScript: job.recapScript,
        segments: job.segments,

        job: getPublicJob(job, req)
      });

    } catch (error) {
      console.error("RECAP ERROR:", error);

      job.status = "recap_error";
      job.error = error.message;

      res.status(getErrorStatus(error) || 500).json({
        success: false,
        error: error.message ||
          "Recap လုပ်ဆောင်မှု မအောင်မြင်ပါ။"
      });

    } finally {
      if (uploadedGeminiFile?.name) {
        try {
          const ai = getGemini();

          await ai.files.delete({
            name: uploadedGeminiFile.name
          });
        } catch (deleteError) {
          console.warn(
            "GEMINI FILE DELETE WARNING:",
            deleteError.message
          );
        }
      }

      job.busy = false;
    }
  }
);

/* =========================================================
   WAV AUDIO HELPERS
========================================================= */

async function savePcmAsWav(
  filePath,
  pcmBuffer,
  sampleRate = 24000,
  channels = 1
) {
  if (!Buffer.isBuffer(pcmBuffer) || pcmBuffer.length === 0) {
    throw new Error(
      "Gemini TTS က Audio Data မပြန်ပေးပါ။"
    );
  }

  const header = Buffer.alloc(44);

  const bitsPerSample = 16;
  const byteRate =
    sampleRate * channels * bitsPerSample / 8;

  const blockAlign =
    channels * bitsPerSample / 8;

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcmBuffer.length, 4);

  header.write("WAVE", 8);
  header.write("fmt ", 12);

  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);

  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);

  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);

  header.writeUInt16LE(bitsPerSample, 34);

  header.write("data", 36);
  header.writeUInt32LE(pcmBuffer.length, 40);

  await fsp.writeFile(
    filePath,
    Buffer.concat([header, pcmBuffer])
  );
}

/* =========================================================
   GEMINI FLASH TTS
========================================================= */

async function generateTtsPcm(text) {
  const ai = getGemini();

  // Only this model is used.
  // There is NO Pro model fallback.
  const model = TTS_MODEL;

  let lastError = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model,

        contents: [
          {
            parts: [
              {
                text:
                  "သဘာဝကျသော မြန်မာ Movie Recap Narrator အသံဖြင့် " +
                  "ရှင်းလင်းပြတ်သားစွာ ဖတ်ပါ။ " +
                  "စာသားကို မပြောင်းလဲပါနှင့်။ " +
                  "အင်္ဂလိပ်အသံထွက်ကို တတ်နိုင်သမျှ ရှောင်ပါ။\n\n" +
                  text
              }
            ]
          }
        ],

        config: {
          responseModalities: ["AUDIO"],

          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: TTS_VOICE
              }
            }
          }
        }
      });

      const parts =
        response?.candidates?.[0]?.content?.parts || [];

      const audioPart = parts.find(
        part =>
          part.inlineData?.data ||
          part.inline_data?.data
      );

      const base64Data =
        audioPart?.inlineData?.data ||
        audioPart?.inline_data?.data;

      if (!base64Data) {
        throw new Error(
          "Gemini Flash TTS မှ Audio Data မရရှိပါ။"
        );
      }

      return Buffer.from(base64Data, "base64");

    } catch (error) {
      lastError = error;

      const status = getErrorStatus(error);

      // Do not retry exhausted quota.
      if (isQuotaExceeded(error)) {
        throw new Error(formatApiError(error));
      }

      if (status === 429) {
        throw new Error(formatApiError(error));
      }

      // Retry same Flash model only for temporary server errors.
      if (status === 503 && attempt < 2) {
        await sleep(8000 * (attempt + 1));
        continue;
      }

      throw new Error(formatApiError(error));
    }
  }

  throw new Error(formatApiError(lastError));
}

/* =========================================================
   CONCAT WAV FILES
========================================================= */

async function concatenateWavFiles(
  inputFiles,
  outputFile,
  listFile
) {
  if (!inputFiles.length) {
    throw new Error(
      "ပေါင်းစပ်ရန် Voice Audio မရှိပါ။"
    );
  }

  if (inputFiles.length === 1) {
    await fsp.copyFile(
      inputFiles[0],
      outputFile
    );

    return;
  }

  const listText = inputFiles
    .map(file => {
      const escaped = file.replace(/'/g, "'\\''");
      return `file '${escaped}'`;
    })
    .join("\n");

  await fsp.writeFile(listFile, listText);

  await new Promise((resolve, reject) => {
    ffmpeg()
      .input(listFile)
      .inputOptions([
        "-f concat",
        "-safe 0"
      ])
      .outputOptions([
        "-y",
        "-c:a pcm_s16le"
      ])
      .format("wav")
      .on("end", resolve)
      .on("error", reject)
      .save(outputFile);
  });
}

/* =========================================================
   GENERATE BURMESE VOICE
========================================================= */

app.post(
  "/api/jobs/:id/voice",
  async (req, res) => {
    const job = getJob(req.params.id);

    if (job.busy) {
      return res.status(409).json({
        success: false,
        error: "ဒီ Video ကို လုပ်ဆောင်နေပြီး ဖြစ်ပါတယ်။"
      });
    }

    if (!job.segments?.length) {
      return res.status(400).json({
        success: false,
        error: "Recap Script မရှိသေးပါ။ Recap ကို အရင်လုပ်ပါ။"
      });
    }

    job.busy = true;
    job.status = "generating_voice";
    job.error = null;

    try {
      const audioFiles = [];

      job.voiceSegments = [];

      const total = job.segments.length;

      for (let i = 0; i < total; i++) {
        const segment = job.segments[i];

        updateProgress(
          job,
          ((i + 1) / total) * 95,
          `မြန်မာ AI Voice ထုတ်နေပါတယ်။ ${i + 1}/${total}`
        );

        const narration = String(
          segment.narration || ""
        ).trim();

        if (!narration) {
          continue;
        }

        if (narration.length > 6000) {
          throw new Error(
            `Recap Segment ${i + 1} စာသား အရမ်းရှည်နေပါတယ်။`
          );
        }

        const pcm = await generateTtsPcm(narration);

        const filename =
          `${job.id}_voice_${String(i).padStart(4, "0")}.wav`;

        const audioPath = path.join(
          OUTPUT_DIR,
          filename
        );

        await savePcmAsWav(
          audioPath,
          pcm,
          24000,
          1
        );

        const audioDuration =
          await getMediaDuration(audioPath);

        audioFiles.push(audioPath);

        job.voiceSegments.push({
          start: segment.start,
          end: segment.end,
          audioPath,
          audioDuration
        });

        // Reduce request pressure.
        if (i < total - 1) {
          await sleep(2000);
        }
      }

      if (!audioFiles.length) {
        throw new Error(
          "Voice Audio မထုတ်နိုင်ပါ။"
        );
      }

      const combinedName =
        `${job.id}_voice.wav`;

      const combinedPath = path.join(
        OUTPUT_DIR,
        combinedName
      );

      const listPath = path.join(
        TEMP_DIR,
        `${job.id}_voice_list.txt`
      );

      await concatenateWavFiles(
        audioFiles,
        combinedPath,
        listPath
      );

      job.voiceUrl = `/outputs/${combinedName}`;

      job.status = "voice_done";

      updateProgress(
        job,
        100,
        "မြန်မာ AI Voice အောင်မြင်ပါပြီ။"
      );

      res.json({
        success: true,

        message: "မြန်မာ AI Voice အောင်မြင်ပါပြီ။",

        voiceUrl: getPublicUrl(
          req,
          job.voiceUrl
        ),

        job: getPublicJob(job, req)
      });

    } catch (error) {
      console.error("VOICE ERROR:", error);

      job.status = "voice_error";
      job.error = formatApiError(error);

      const status = getErrorStatus(error);

      res.status(status === 429 ? 429 : 500).json({
        success: false,
        error: job.error
      });

    } finally {
      job.busy = false;
    }
  }
);

/* =========================================================
   RENDER ONE VIDEO SEGMENT
========================================================= */

function renderOneSegment(
  originalVideo,
  voiceAudio,
  outputFile,
  start,
  clipDuration,
  voiceDuration
) {
  return new Promise((resolve, reject) => {
    const extraVideoTime = Math.max(
      0,
      voiceDuration - clipDuration
    );

    const videoFilter = [
      "scale=1280:720:force_original_aspect_ratio=decrease",
      "pad=1280:720:(ow-iw)/2:(oh-ih)/2",
      "setsar=1",
      "fps=30",
      `tpad=stop_mode=clone:stop_duration=${extraVideoTime}`,
      `trim=duration=${voiceDuration}`,
      "setpts=PTS-STARTPTS"
    ].join(",");

    const audioFilter = [
      "aresample=24000",
      "apad",
      `atrim=duration=${voiceDuration}`,
      "asetpts=PTS-STARTPTS"
    ].join(",");

    const filterComplex = [
      `[0:v:0]${videoFilter}[v]`,
      `[1:a:0]${audioFilter}[a]`
    ];

    ffmpeg()
      .input(originalVideo)
      .inputOptions([
        `-ss ${start}`
      ])

      .input(voiceAudio)

      .complexFilter(filterComplex)

      .outputOptions([
        "-y",

        "-map [v]",
        "-map [a]",

        "-c:v libx264",
        "-preset veryfast",
        "-crf 23",
        "-pix_fmt yuv420p",

        "-c:a aac",
        "-b:a 128k",
        "-ar 48000",
        "-ac 2",

        `-t ${voiceDuration}`,

        "-movflags +faststart"
      ])

      .on("end", resolve)
      .on("error", reject)

      .save(outputFile);
  });
}

/* =========================================================
   RENDER FINAL MP4
========================================================= */

app.post(
  "/api/jobs/:id/render",
  async (req, res) => {
    const job = getJob(req.params.id);

    if (job.busy) {
      return res.status(409).json({
        success: false,
        error: "ဒီ Video ကို Render လုပ်ဆောင်နေပြီး ဖြစ်ပါတယ်။"
      });
    }

    if (!job.voiceSegments?.length || !job.voiceUrl) {
      return res.status(400).json({
        success: false,
        error: "Voice Audio မရှိသေးပါ။ Voice ကို အရင်ထုတ်ပါ။"
      });
    }

    job.busy = true;
    job.status = "rendering";
    job.error = null;

    const workDir = path.join(
      TEMP_DIR,
      job.id
    );

    try {
      await fsp.mkdir(workDir, {
        recursive: true
      });

      const renderedFiles = [];

      const total = job.voiceSegments.length;

      for (let i = 0; i < total; i++) {
        const segment = job.voiceSegments[i];

        const clipDuration = Math.max(
          0.5,
          segment.end - segment.start
        );

        const voiceDuration = Math.max(
          0.5,
          segment.audioDuration
        );

        const renderedFile = path.join(
          workDir,
          `segment_${String(i).padStart(4, "0")}.mp4`
        );

        updateProgress(
          job,
          ((i + 1) / total) * 90,
          `Video နဲ့ မြန်မာအသံ ပေါင်းစပ်နေပါတယ်။ ${i + 1}/${total}`
        );

        await renderOneSegment(
          job.filePath,
          segment.audioPath,
          renderedFile,
          segment.start,
          clipDuration,
          voiceDuration
        );

        renderedFiles.push(renderedFile);
      }

      if (!renderedFiles.length) {
        throw new Error(
          "Render လုပ်ရန် Video Segment မရှိပါ။"
        );
      }

      updateProgress(
        job,
        95,
        "Final MP4 ကို ပေါင်းစပ်နေပါတယ်။"
      );

      const listFile = path.join(
        workDir,
        "concat.txt"
      );

      const concatText = renderedFiles
        .map(file => {
          const escaped = file.replace(/'/g, "'\\''");
          return `file '${escaped}'`;
        })
        .join("\n");

      await fsp.writeFile(
        listFile,
        concatText
      );

      const outputFilename =
        `${job.id}_final.mp4`;

      const finalPath = path.join(
        OUTPUT_DIR,
        outputFilename
      );

      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(listFile)

          .inputOptions([
            "-f concat",
            "-safe 0"
          ])

          .outputOptions([
            "-y",
            "-c copy",
            "-movflags +faststart"
          ])

          .on("end", resolve)
          .on("error", reject)

          .save(finalPath);
      });

      job.outputUrl = `/outputs/${outputFilename}`;

      job.status = "completed";

      updateProgress(
        job,
        100,
        "HWA EDITOR အောင်မြင်စွာ MP4 ထုတ်ပြီးပါပြီ။"
      );

      res.json({
        success: true,

        message: "Final MP4 Render အောင်မြင်ပါပြီ။",

        outputUrl: getPublicUrl(
          req,
          job.outputUrl
        ),

        job: getPublicJob(job, req)
      });

      // Remove temporary rendered pieces.
      await fsp.rm(workDir, {
        recursive: true,
        force: true
      }).catch(() => {});

    } catch (error) {
      console.error("RENDER ERROR:", error);

      job.status = "render_error";
      job.error = error.message;

      res.status(500).json({
        success: false,
        error:
          error.message ||
          "Final MP4 Render မအောင်မြင်ပါ။"
      });

    } finally {
      job.busy = false;
    }
  }
);

/* =========================================================
   GET JOB STATUS
========================================================= */

app.get(
  "/api/jobs/:id",
  (req, res) => {
    try {
      const job = getJob(req.params.id);

      res.json({
        success: true,
        job: getPublicJob(job, req)
      });

    } catch (error) {
      res.status(error.status || 404).json({
        success: false,
        error: error.message
      });
    }
  }
);

/* =========================================================
   DELETE JOB
========================================================= */

app.delete(
  "/api/jobs/:id",
  async (req, res) => {
    try {
      const job = getJob(req.params.id);

      if (job.busy) {
        return res.status(409).json({
          success: false,
          error: "အလုပ်လုပ်နေစဉ် ဖျက်လို့မရသေးပါ။"
        });
      }

      await fsp.unlink(job.filePath)
        .catch(() => {});

      const outputFiles = await fsp.readdir(
        OUTPUT_DIR
      );

      for (const filename of outputFiles) {
        if (filename.startsWith(job.id)) {
          await fsp.unlink(
            path.join(OUTPUT_DIR, filename)
          ).catch(() => {});
        }
      }

      await fsp.rm(
        path.join(TEMP_DIR, job.id),
        {
          recursive: true,
          force: true
        }
      );

      jobs.delete(job.id);

      res.json({
        success: true,
        message: "Video Job ဖျက်ပြီးပါပြီ။"
      });

    } catch (error) {
      res.status(error.status || 500).json({
        success: false,
        error: error.message
      });
    }
  }
);

/* =========================================================
   UNKNOWN API ROUTE
========================================================= */

app.use("/api", (req, res) => {
  res.status(404).json({
    success: false,
    error: "ဒီ API လမ်းကြောင်းကို မတွေ့ပါ။"
  });
});

/* =========================================================
   GLOBAL ERROR HANDLER
========================================================= */

app.use((error, req, res, next) => {
  console.error("SERVER ERROR:", error);

  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        success: false,
        error: "Video ဖိုင်အရွယ်အစား 1 GB ကျော်နေပါတယ်။"
      });
    }

    return res.status(400).json({
      success: false,
      error: error.message
    });
  }

  const message =
    error.message ||
    "Server မှာ မသိရသေးတဲ့ အမှားဖြစ်နေပါတယ်။";

  res.status(error.status || 500).json({
    success: false,
    error: message
  });
});

/* =========================================================
   START SERVER
========================================================= */

app.listen(PORT, () => {
  console.log("----------------------------------------");
  console.log("HWA EDITOR · BURMESE MOVIE RECAP");
  console.log("Backend Version: 6.2.0");
  console.log("----------------------------------------");
  console.log(`Server running on port ${PORT}`);
  console.log(`Recap Model: ${RECAP_MODEL}`);
  console.log(`TTS Model: ${TTS_MODEL}`);
  console.log(`TTS Voice: ${TTS_VOICE}`);
  console.log("Pro TTS fallback: DISABLED");
  console.log("----------------------------------------");
});
