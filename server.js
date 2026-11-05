require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const fsp = fs.promises;
const crypto = require("crypto");

const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const ffprobePath = require("ffprobe-static").path;

const app = express();
const PORT = process.env.PORT || 10000;

const MAX_UPLOAD_SIZE =
  Number(process.env.MAX_UPLOAD_SIZE) || 1024 * 1024 * 1024;

const MAX_VIDEO_DURATION =
  Number(process.env.MAX_VIDEO_DURATION) || 350 * 60;

const GEMINI_MODEL =
  process.env.GEMINI_MODEL || "gemini-3.8-flash";

const GEMINI_FALLBACK_MODELS = (
  process.env.GEMINI_FALLBACK_MODELS ||
  "gemini-3.7-flash,gemini-3.6-flash"
).split(",").map(x => x.trim()).filter(Boolean);

const GEMINI_TTS_MODEL =
  process.env.GEMINI_TTS_MODEL || "gemini-3.8-flash-tts";

const GEMINI_TTS_VOICE =
  process.env.GEMINI_TTS_VOICE || "Kore";

const ROOT = __dirname;
const UPLOAD_DIR = path.join(ROOT, "uploads");
const OUTPUT_DIR = path.join(ROOT, "outputs");
const TEMP_DIR = path.join(ROOT, "temp");

for (const dir of [UPLOAD_DIR, OUTPUT_DIR, TEMP_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

if (!ffmpegPath || !ffprobePath) {
  throw new Error("FFmpeg or FFprobe binary missing.");
}

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

app.use(express.json({ limit: "10mb" }));

app.use(cors({
  origin: process.env.FRONTEND_URL
    ? process.env.FRONTEND_URL.split(",").map(x => x.trim())
    : "*",
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use("/outputs", express.static(OUTPUT_DIR));

const jobs = new Map();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function errorMessage(error) {
  return error?.message || String(error);
}

function getAIClient() {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY မသတ်မှတ်ရသေးပါ။");
  }

  return import("@google/genai").then(({ GoogleGenAI }) => {
    return new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY
    });
  });
}

function safeUnlink(file) {
  if (!file || !fs.existsSync(file)) return Promise.resolve();
  return fsp.unlink(file).catch(() => {});
}

function publicUrl(req, filename) {
  return `${req.protocol}://${req.get("host")}/outputs/${encodeURIComponent(filename)}`;
}

function runFFmpeg(command) {
  return new Promise((resolve, reject) => {
    command
      .on("start", cmd => console.log("FFmpeg:", cmd))
      .on("progress", p => {
        if (p.percent) console.log("Render:", p.percent.toFixed(1) + "%");
      })
      .on("end", resolve)
      .on("error", reject)
      .run();
  });
}

function probe(file) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(file, (err, data) => {
      if (err) return reject(err);

      const video = data.streams.find(s => s.codec_type === "video");
      const audio = data.streams.find(s => s.codec_type === "audio");

      if (!video) return reject(new Error("Video stream မတွေ့ပါ။"));

      resolve({
        duration: Number(data.format.duration || 0),
        width: Number(video.width || 0),
        height: Number(video.height || 0),
        resolution: `${video.width || 0}x${video.height || 0}`,
        frameRate: video.r_frame_rate || "unknown",
        hasAudio: Boolean(audio),
        audioCodec: audio?.codec_name || null,
        videoCodec: video.codec_name || null,
        size: Number(data.format.size || 0)
      });
    });
  });
}

async function generateRecap(ai, contents) {
  const models = [...new Set([GEMINI_MODEL, ...GEMINI_FALLBACK_MODELS])];
  let lastError;

  for (const model of models) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents
        });

        const text = response.text?.trim();
        if (!text) throw new Error("AI က Recap စာသားမပြန်ပေးပါ။");

        return { text, model };
      } catch (error) {
        lastError = error;
        console.error("Recap model error:", model, errorMessage(error));

        if (attempt < 2) await sleep(2500);
      }
    }
  }

  throw lastError || new Error("Gemini recap မအောင်မြင်ပါ။");
}

function splitText(text, maxChars = 2200) {
  const sentences = String(text || "")
    .replace(/\r/g, "")
    .split(/(?<=[။.!?])/);

  const chunks = [];
  let current = "";

  for (const sentence of sentences) {
    const part = sentence.trim();
    if (!part) continue;

    if ((current + " " + part).length > maxChars && current) {
      chunks.push(current);
      current = "";
    }

    current += (current ? " " : "") + part;
  }

  if (current) chunks.push(current);

  return chunks;
}

function createWavBuffer(pcm, sampleRate = 24000) {
  const channels = 1;
  const bits = 16;
  const align = channels * bits / 8;
  const header = Buffer.alloc(44);

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * align, 28);
  header.writeUInt16LE(align, 32);
  header.writeUInt16LE(bits, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

async function generateSpeech(ai, text, outputPath) {
  const response = await ai.models.generateContent({
    model: GEMINI_TTS_MODEL,
    contents: [{
      role: "user",
      parts: [{
        text:
          "Speak this Burmese narration clearly and naturally. " +
          "Use a warm storytelling voice, natural Burmese pronunciation, " +
          "moderate pace, and clear pauses.\n\n" + text
      }]
    }],
    config: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: GEMINI_TTS_VOICE
          }
        }
      }
    }
  });

  const part = response.candidates?.[0]?.content?.parts?.find(
    p => p.inlineData?.data
  );

  if (!part) throw new Error("Gemini TTS အသံဖိုင် မရရှိပါ။");

  const buffer = Buffer.from(part.inlineData.data, "base64");
  const mime = part.inlineData.mimeType || "";

  if (!buffer.length) throw new Error("TTS အသံဖိုင် ဗလာဖြစ်နေပါတယ်။");

  if (mime.includes("wav") || buffer.toString("ascii", 0, 4) === "RIFF") {
    await fsp.writeFile(outputPath, buffer);
    return;
  }

  const rate = Number(mime.match(/rate=(\d+)/i)?.[1] || 24000);
  await fsp.writeFile(outputPath, createWavBuffer(buffer, rate));
}

async function combineWavFiles(files, output) {
  if (!files.length) throw new Error("အသံဖိုင် မရှိပါ။");

  const command = ffmpeg();
  files.forEach(file => command.input(file));

  const labels = files.map((_, i) => `[${i}:a:0]`).join("");
  const filter = `${labels}concat=n=${files.length}:v=0:a=1[out]`;

  await runFFmpeg(
    command
      .complexFilter(filter)
      .outputOptions([
        "-map [out]",
        "-ac 1",
        "-ar 24000",
        "-c:a pcm_s16le"
      ])
      .format("wav")
      .output(output)
  );
}

const allowedExtensions = [
  ".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"
];

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${crypto.randomUUID()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: MAX_UPLOAD_SIZE,
    files: 1
  },
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();

    if (!allowedExtensions.includes(ext)) {
      return cb(new Error("MP4, MOV, MKV, WEBM, AVI, M4V ဖိုင်များသာ ခွင့်ပြုသည်။"));
    }

    cb(null, true);
  }
});

// HEALTH

app.get("/", (req, res) => {
  res.json({
    success: true,
    service: "HWA Burmese Auto Recap & Editor",
    version: "5.0.0",
    status: "OK"
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    status: "OK",
    version: "5.0.0",
    ffmpeg: Boolean(ffmpegPath),
    ffprobe: Boolean(ffprobePath),
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
    recapModel: GEMINI_MODEL,
    ttsModel: GEMINI_TTS_MODEL,
    ttsVoice: GEMINI_TTS_VOICE,
    maxUploadSize: MAX_UPLOAD_SIZE,
    maxVideoDuration: MAX_VIDEO_DURATION
  });
});

// UPLOAD

app.post("/api/upload", upload.single("video"), async (req, res) => {
  let filePath;

  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Video ဖိုင်ရွေးပေးပါ။"
      });
    }

    filePath = req.file.path;
    const info = await probe(filePath);

    if (info.duration <= 0) throw new Error("Video ကြာချိန် မသိရှိနိုင်ပါ။");

    if (info.duration > MAX_VIDEO_DURATION) {
      await safeUnlink(filePath);
      return res.status(400).json({
        success: false,
        message: "Video ကြာချိန် ကန့်သတ်ချက်ကျော်နေပါတယ်။",
        maxDuration: MAX_VIDEO_DURATION,
        actualDuration: info.duration
      });
    }

    const id = crypto.randomUUID();

    const job = {
      id,
      status: "ready",
      progress: 5,
      stage: "Video uploaded",
      originalName: req.file.originalname,
      filePath,
      fileSize: req.file.size,
      videoInfo: info,
      recapScript: null,
      recapStatus: "not_started",
      voiceFile: null,
      voiceUrl: null,
      voiceStatus: "not_started",
      outputFile: null,
      outputUrl: null,
      renderStatus: "not_started",
      error: null
    };

    jobs.set(id, job);

    res.status(201).json({
      success: true,
      message: "Video upload အောင်မြင်ပါပြီ။",
      job: {
        id,
        status: job.status,
        progress: job.progress,
        stage: job.stage,
        originalName: job.originalName,
        videoInfo: info
      }
    });
  } catch (error) {
    await safeUnlink(filePath);
    res.status(500).json({
      success: false,
      message: errorMessage(error)
    });
  }
});

// RECAP

app.post("/api/jobs/:id/recap", async (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({ success: false, message: "Job မတွေ့ပါ။" });
  }

  if (!fs.existsSync(job.filePath)) {
    return res.status(404).json({ success: false, message: "Video ဖိုင် ပျောက်နေပါတယ်။" });
  }

  if (job.recapStatus === "processing") {
    return res.status(409).json({ success: false, message: "Recap လုပ်နေဆဲပါ။" });
  }

  try {
    const ai = await getAIClient();

    job.recapStatus = "processing";
    job.status = "recapping";
    job.progress = 10;
    job.stage = "AI က Video ကို စစ်ဆေးနေပါတယ်။";

    const ext = path.extname(job.filePath).toLowerCase();

    const mimeMap = {
      ".mp4": "video/mp4",
      ".mov": "video/quicktime",
      ".mkv": "video/x-matroska",
      ".webm": "video/webm",
      ".avi": "video/x-msvideo",
      ".m4v": "video/mp4"
    };

    let file = await ai.files.upload({
      file: job.filePath,
      config: {
        mimeType: mimeMap[ext] || "video/mp4",
        displayName: job.originalName
      }
    });

    const start = Date.now();

    while (file.state === "PROCESSING") {
      if (Date.now() - start > 10 * 60 * 1000) {
        throw new Error("Gemini Video processing အချိန်ကျော်သွားပါတယ်။");
      }

      await sleep(3000);
      file = await ai.files.get({ name: file.name });
    }

    if (file.state !== "ACTIVE") {
      throw new Error(`Gemini file state: ${file.state}`);
    }

    job.progress = 40;
    job.stage = "ဇာတ်လမ်းကို ခွဲခြမ်းစိတ်ဖြာနေပါတယ်။";

    const prompt = `
You are an expert Burmese movie recap storyteller.

Analyze the uploaded video itself.

Write a detailed Burmese-language recap in chronological order.
Use natural, engaging Burmese narration suitable for a YouTube audience.

Requirements:
- Start with a strong but truthful hook.
- Explain the story in the order it happens.
- Explain important characters and motivations.
- Include important conflicts and turning points.
- Explain meaningful conversations in your own words.
- Preserve important scenes and story details.
- Do not invent events, characters, dialogue, or facts.
- Do not guess unclear scenes.
- Do not reproduce long original movie dialogue.
- Do not claim that this recap is an official version.
- Do not copy a published recap or review.
- Use original wording and original storytelling.
- Do not skip important plot developments.
- Explain the ending only if visible in the uploaded video.
- Return only the Burmese narration script.
`;

    const result = await generateRecap(ai, [{
      role: "user",
      parts: [
        {
          fileData: {
            fileUri: file.uri,
            mimeType: file.mimeType || mimeMap[ext] || "video/mp4"
          }
        },
        { text: prompt }
      ]
    }]);

    job.recapScript = result.text;
    job.recapModel = result.model;
    job.recapStatus = "completed";
    job.status = "ready";
    job.progress = 50;
    job.stage = "Recap အောင်မြင်ပါပြီ။";

    res.json({
      success: true,
      usedModel: result.model,
      job: {
        id: job.id,
        recapStatus: job.recapStatus,
        recapScript: job.recapScript,
        progress: job.progress,
        stage: job.stage
      }
    });
  } catch (error) {
    console.error("RECAP ERROR:", error);
    job.recapStatus = "failed";
    job.status = "error";
    job.error = errorMessage(error);

    res.status(500).json({
      success: false,
      message: job.error
    });
  }
});

// VOICE

app.post("/api/jobs/:id/voice", async (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({ success: false, message: "Job မတွေ့ပါ။" });
  }

  const text = String(req.body?.text || job.recapScript || "").trim();

  if (!text) {
    return res.status(400).json({ success: false, message: "Recap စာသား မရှိပါ။" });
  }

  if (job.voiceStatus === "processing") {
    return res.status(409).json({ success: false, message: "Voice ဖန်တီးနေဆဲပါ။" });
  }

  const chunks = splitText(text);
  const chunkFiles = [];

  try {
    const ai = await getAIClient();

    job.voiceStatus = "processing";
    job.progress = 55;
    job.stage = "မြန်မာ AI အသံ ဖန်တီးနေပါတယ်။";

    for (let i = 0; i < chunks.length; i++) {
      const chunkPath = path.join(TEMP_DIR, `${job.id}-${i}.wav`);

      await generateSpeech(ai, chunks[i], chunkPath);
      chunkFiles.push(chunkPath);

      job.progress = 55 + Math.round(((i + 1) / chunks.length) * 25);
      job.stage = `အသံဖန်တီးနေပါတယ် ${i + 1}/${chunks.length}`;
    }

    const filename = `${job.id}-voice.wav`;
    const output = path.join(OUTPUT_DIR, filename);

    await combineWavFiles(chunkFiles, output);

    const audioInfo = await probeAudio(output);

    if (audioInfo.duration <= 0) {
      throw new Error("Voice အသံဖိုင် မမှန်ကန်ပါ။");
    }

    job.voiceFile = output;
    job.voiceUrl = publicUrl(req, filename);
    job.voiceStatus = "completed";
    job.progress = 80;
    job.stage = "မြန်မာအသံ အဆင်သင့်ဖြစ်ပါပြီ။";

    res.json({
      success: true,
      job: {
        id: job.id,
        voiceStatus: job.voiceStatus,
        voiceUrl: job.voiceUrl,
        audioInfo,
        progress: job.progress,
        stage: job.stage
      }
    });
  } catch (error) {
    console.error("VOICE ERROR:", error);
    job.voiceStatus = "failed";
    job.error = errorMessage(error);

    res.status(500).json({
      success: false,
      message: job.error
    });
  } finally {
    for (const file of chunkFiles) await safeUnlink(file);
  }
});

function probeAudio(file) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(file, (err, data) => {
      if (err) return reject(err);

      const audio = data.streams.find(s => s.codec_type === "audio");
      if (!audio) return reject(new Error("Audio stream မတွေ့ပါ။"));

      resolve({
        duration: Number(data.format.duration || 0),
        codec: audio.codec_name || "unknown"
      });
    });
  });
}

// RENDER — ORIGINAL AUDIO + BURMESE VOICE

app.post("/api/jobs/:id/render", async (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({ success: false, message: "Job မတွေ့ပါ။" });
  }

  if (!fs.existsSync(job.filePath)) {
    return res.status(404).json({ success: false, message: "မူရင်း Video မတွေ့ပါ။" });
  }

  if (!job.voiceFile || !fs.existsSync(job.voiceFile)) {
    return res.status(400).json({ success: false, message: "မြန်မာ AI Voice အရင်ဖန်တီးပါ။" });
  }

  if (job.renderStatus === "processing") {
    return res.status(409).json({ success: false, message: "Render လုပ်နေဆဲပါ။" });
  }

  try {
    job.renderStatus = "processing";
    job.status = "rendering";
    job.progress = 82;
    job.stage = "Cinematic Edit နှင့် Audio Mix လုပ်နေပါတယ်။";

    const settings = req.body || {};

    const originalVolume = clamp(settings.originalVolume, 0, 1, 0.15);
    const voiceVolume = clamp(settings.voiceVolume, 0, 2, 1);
    const brightness = clamp(settings.brightness, -0.15, 0.15, 0);
    const contrast = clamp(settings.contrast, 0.5, 2, 1.08);
    const saturation = clamp(settings.saturation, 0, 2, 1.08);
    const zoom = clamp(settings.zoom, 1, 1.5, 1);
    const speed = clamp(settings.speed, 0.5, 2, 1);

    const filename = `${job.id}-hwa-edited.mp4`;
    const output = path.join(OUTPUT_DIR, filename);

    const duration = Number(job.videoInfo.duration || 0);

    const filters = [];

    const cropWidth = `(iw/${zoom})`;
    const cropHeight = `(ih/${zoom})`;

    let videoFilter =
      `scale=iw*${zoom}:ih*${zoom},` +
      `crop=${cropWidth}:${cropHeight}:(in_w-out_w)/2:(in_h-out_h)/2,` +
      `eq=brightness=${brightness}:contrast=${contrast}:saturation=${saturation},` +
      `setpts=PTS/${speed}`;

    filters.push(`[0:v:0]${videoFilter}[vout]`);

    let audioMap;

    if (job.videoInfo.hasAudio) {
      filters.push(
        `[0:a:0]volume=${originalVolume},atempo=${speed}[orig]`
      );

      filters.push(
        `[1:a:0]volume=${voiceVolume},atempo=${speed}[voice]`
      );

      filters.push(
        `[orig][voice]amix=inputs=2:duration=longest:dropout_transition=2:normalize=0[aout]`
      );

      audioMap = "[aout]";
    } else {
      filters.push(
        `[1:a:0]volume=${voiceVolume},atempo=${speed}[aout]`
      );

      audioMap = "[aout]";
    }

    await runFFmpeg(
      ffmpeg()
        .input(job.filePath)
        .input(job.voiceFile)
        .complexFilter(filters)
        .outputOptions([
          "-map [vout]",
          `-map ${audioMap}`,
          "-c:v libx264",
          "-preset veryfast",
          "-crf 21",
          "-pix_fmt yuv420p",
          "-c:a aac",
          "-b:a 192k",
          "-ar 48000",
          "-movflags +faststart",
          "-shortest"
        ])
        .output(output)
    );

    if (!fs.existsSync(output) || fs.statSync(output).size === 0) {
      throw new Error("MP4 ဖိုင် မထွက်လာပါ။");
    }

    job.outputFile = output;
    job.outputUrl = publicUrl(req, filename);
    job.renderStatus = "completed";
    job.status = "ready";
    job.progress = 100;
    job.stage = "MP4 Export အောင်မြင်ပါပြီ။";

    res.json({
      success: true,
      message: "HWA Edited MP4 အောင်မြင်စွာ ထွက်ရှိပါပြီ။",
      job: {
        id: job.id,
        renderStatus: job.renderStatus,
        outputUrl: job.outputUrl,
        progress: 100,
        stage: job.stage
      }
    });
  } catch (error) {
    console.error("RENDER ERROR:", error);
    job.renderStatus = "failed";
    job.status = "error";
    job.error = errorMessage(error);

    res.status(500).json({
      success: false,
      message: job.error
    });
  }
});

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

// JOB STATUS

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({ success: false, message: "Job မတွေ့ပါ။" });
  }

  res.json({
    success: true,
    job: {
      id: job.id,
      status: job.status,
      progress: job.progress,
      stage: job.stage,
      originalName: job.originalName,
      videoInfo: job.videoInfo,
      recapStatus: job.recapStatus,
      recapScript: job.recapScript,
      voiceStatus: job.voiceStatus,
      voiceUrl: job.voiceUrl,
      renderStatus: job.renderStatus,
      outputUrl: job.outputUrl,
      error: job.error
    }
  });
});

// DELETE

app.delete("/api/jobs/:id", async (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({ success: false, message: "Job မတွေ့ပါ။" });
  }

  await Promise.all([
    safeUnlink(job.filePath),
    safeUnlink(job.voiceFile),
    safeUnlink(job.outputFile)
  ]);

  jobs.delete(req.params.id);

  res.json({
    success: true,
    message: "Job ဖျက်ပြီးပါပြီ။"
  });
});

// ERROR HANDLER

app.use((error, req, res, next) => {
  console.error("SERVER ERROR:", error);

  if (error instanceof multer.MulterError) {
    return res.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({
      success: false,
      message: error.code === "LIMIT_FILE_SIZE"
        ? "Video ဖိုင်အရွယ်အစား 1GB ကျော်နေပါတယ်။"
        : error.message
    });
  }

  res.status(400).json({
    success: false,
    message: errorMessage(error)
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("==================================");
  console.log("HWA Burmese Auto Recap & Editor");
  console.log("Version: 5.0.0");
  console.log("Port:", PORT);
  console.log("==================================");
});
