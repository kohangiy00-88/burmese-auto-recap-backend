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

const RECAP_MODEL =
  process.env.GEMINI_MODEL || "gemini-3.8-flash";

const RECAP_FALLBACKS = (
  process.env.GEMINI_FALLBACK_MODELS || ""
).split(",").map(x => x.trim()).filter(Boolean);

const TTS_MODEL =
  process.env.GEMINI_TTS_MODEL || "gemini-3.8-flash-tts";

const TTS_FALLBACKS = (
  process.env.GEMINI_TTS_FALLBACK_MODELS ||
  "gemini-2.5-flash-preview-tts,gemini-2.5-pro-preview-tts"
).split(",").map(x => x.trim()).filter(Boolean);

const TTS_VOICE = process.env.GEMINI_TTS_VOICE || "Kore";

const ROOT = __dirname;
const UPLOAD_DIR = path.join(ROOT, "uploads");
const OUTPUT_DIR = path.join(ROOT, "outputs");
const TEMP_DIR = path.join(ROOT, "temp");

for (const dir of [UPLOAD_DIR, OUTPUT_DIR, TEMP_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

if (!ffmpegPath || !ffprobePath) {
  throw new Error("FFmpeg / FFprobe မတွေ့ပါ။");
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

function message(error) {
  return error?.message || String(error);
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
        if (p.percent) {
          console.log("Render:", p.percent.toFixed(1) + "%");
        }
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

      if (!video) {
        return reject(new Error("Video stream မတွေ့ပါ။"));
      }

      resolve({
        duration: Number(data.format.duration || 0),
        width: Number(video.width || 0),
        height: Number(video.height || 0),
        resolution: `${video.width || 0}x${video.height || 0}`,
        frameRate: video.r_frame_rate || "unknown",
        hasAudio: Boolean(audio),
        size: Number(data.format.size || 0)
      });
    });
  });
}

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

async function getAIClient() {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("Render Environment ထဲမှာ GEMINI_API_KEY မရှိပါ။");
  }

  const { GoogleGenAI } = await import("@google/genai");

  return new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY
  });
}

function isTemporary(error) {
  const m = message(error).toLowerCase();

  return [
    "503", "unavailable", "high demand",
    "429", "resource_exhausted", "rate limit",
    "timeout", "temporarily"
  ].some(x => m.includes(x));
}

async function retry(task, label, attempts = 3) {
  let lastError;

  for (let i = 1; i <= attempts; i++) {
    try {
      console.log(`${label}: ${i}/${attempts}`);
      return await task();
    } catch (error) {
      lastError = error;
      console.error(label, message(error));

      if (!isTemporary(error) || i === attempts) {
        throw error;
      }

      await sleep(Math.min(3000 * i, 12000));
    }
  }

  throw lastError;
}

function hasMyanmar(text) {
  return /[\u1000-\u109F]/.test(String(text || ""));
}

function cleanJson(text) {
  return String(text || "")
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
}

function parseSegments(text, duration) {
  let data;

  try {
    data = JSON.parse(cleanJson(text));
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");

    if (start < 0 || end <= start) {
      throw new Error("AI ရဲ့ Timestamp JSON ကို ဖတ်မရပါ။");
    }

    data = JSON.parse(text.slice(start, end + 1));
  }

  if (!Array.isArray(data.segments)) {
    throw new Error("AI က Recap အပိုင်းများ မထုတ်ပေးပါ။");
  }

  const segments = data.segments
    .map((item, index) => {
      const start = Number(item.start);
      const end = Number(item.end);
      const narration = String(item.narration || "").trim();

      return {
        index: index + 1,
        start,
        end,
        narration
      };
    })
    .filter(s =>
      Number.isFinite(s.start) &&
      Number.isFinite(s.end) &&
      s.start >= 0 &&
      s.end > s.start &&
      s.start < duration &&
      s.narration.length > 0
    )
    .sort((a, b) => a.start - b.start)
    .slice(0, 180);

  if (!segments.length) {
    throw new Error("အသုံးပြုနိုင်တဲ့ Recap အပိုင်း မရှိပါ။");
  }

  for (const segment of segments) {
    segment.end = Math.min(segment.end, duration);

    if (segment.end - segment.start < 1) {
      throw new Error("AI Timestamp အပိုင်းတစ်ခု၏ ကြာချိန် မမှန်ပါ။");
    }

    if (!hasMyanmar(segment.narration)) {
      throw new Error(
        `အပိုင်း ${segment.index} မှာ မြန်မာစာ မပါပါ။ Recap ပြန်ထုတ်ရန်လိုသည်။`
      );
    }
  }

  return segments;
}

function joinNarration(segments) {
  return segments
    .map(s => s.narration)
    .join("\n\n");
}

// Gemini video upload

async function uploadToGemini(ai, job) {
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

  const started = Date.now();

  while (file.state === "PROCESSING") {
    if (Date.now() - started > 20 * 60 * 1000) {
      throw new Error("Gemini Video processing အချိန်ကျော်သွားပါတယ်။");
    }

    await sleep(4000);
    file = await ai.files.get({ name: file.name });
  }

  if (file.state !== "ACTIVE") {
    throw new Error(`Gemini Video State: ${file.state}`);
  }

  return file;
}

// Detailed Burmese timestamped recap

async function generateTimestampedRecap(ai, file, job) {
  const models = [...new Set([RECAP_MODEL, ...RECAP_FALLBACKS])];
  let lastError;

  const prompt = `
သင်သည် မြန်မာဘာသာဖြင့် ရုပ်ရှင်ဇာတ်လမ်း အသေးစိတ်ပြန်လည်တင်ဆက်ပေးသော
ကျွမ်းကျင် Movie Recap Storyteller ဖြစ်သည်။

တင်ထားသော Video ကို ကိုယ်တိုင်ကြည့်ရှုပြီး အစမှအဆုံး ဇာတ်လမ်းကို
အချိန်အစဉ်အတိုင်း ဆန်းစစ်ပါ။

အရေးကြီးချက်များ -
1. ဇာတ်လမ်းအရေးကြီးသော အဖြစ်အပျက်များကို မကျန်စေရ။
2. အရေးကြီးသော ဇာတ်ကောင်များ၊ ဆက်ဆံရေး၊ ရည်ရွယ်ချက်များကို ရှင်းပြပါ။
3. အရေးကြီးသော စကားပြောခန်းများ၏ အဓိပ္ပာယ်ကို ကိုယ်ပိုင်မြန်မာစကားဖြင့် ပြန်ပြောပါ။
4. မူရင်း Dialogue အရှည်ကြီးကို တိုက်ရိုက်မကူးပါနှင့်။
5. မူရင်း Video ထဲတွင် မပါသော အဖြစ်အပျက်ကို မတီထွင်ပါနှင့်။
6. မမြင်ရသော အဖြစ်အပျက်ကို မခန့်မှန်းပါနှင့်။
7. ဇာတ်လမ်း၏ အစ၊ အလယ်၊ အဆုံးကို အစဉ်လိုက် ထိန်းသိမ်းပါ။
8. Narration သည် သဘာဝကျသော မြန်မာစကားပြောပုံစံ ဖြစ်ရမည်။
9. English narration မရေးရ။ မြန်မာစာဖြင့်သာ ရေးပါ။
10. ဇာတ်ကွက်တစ်ခုစီအတွက် Video ထဲရှိ အမှန်တကယ် Timestamp ကို သုံးပါ။
11. Timestamp မသေချာလျှင် မခန့်မှန်းဘဲ မြင်ရသောအပိုင်းကိုသာ ရွေးပါ။
12. အပိုင်းတစ်ခုစီ၏ narration သည် သက်ဆိုင်ရာ ရုပ်ကွက်ကို ရှင်းပြနိုင်ရမည်။
13. ဇာတ်လမ်းကို အလွန်အကျွံ အတိုချုံ့မပစ်ပါနှင့်။
14. အပိုင်းများကို အချိန်အစဉ်လိုက် ပြန်ပေးပါ။

JSON အဖြစ်သာ ပြန်ပေးပါ။ Markdown မသုံးပါနှင့်။

ပုံစံ -
{
  "segments": [
    {
      "start": 0,
      "end": 35,
      "narration": "မြန်မာဘာသာဖြင့် ဇာတ်လမ်းပြန်ပြောရန်..."
    }
  ]
}

Timestamp များသည် စက္ကန့်ဖြစ်သည်။
အပိုင်းတစ်ခုသည် ပုံမှန်အားဖြင့် 15 မှ 60 စက္ကန့်အတွင်း ဖြစ်ပါစေ။
ဇာတ်ကွက်ပြောင်းလဲသည့်နေရာတွင် အပိုင်းခွဲပါ။
အများဆုံး အပိုင်း 180 ခုအထိ ထုတ်ပါ။
`;

  for (const model of models) {
    try {
      const response = await retry(
        () => ai.models.generateContent({
          model,
          contents: [{
            role: "user",
            parts: [
              {
                fileData: {
                  fileUri: file.uri,
                  mimeType: file.mimeType || "video/mp4"
                }
              },
              { text: prompt }
            ]
          }],
          config: {
            responseMimeType: "application/json"
          }
        }),
        `RECAP ${model}`,
        2
      );

      const text = response.text?.trim();

      if (!text) {
        throw new Error("Recap စာသား မရရှိပါ။");
      }

      const segments = parseSegments(text, job.videoInfo.duration);

      return {
        segments,
        model
      };
    } catch (error) {
      lastError = error;
      console.error("Recap model failed:", model, message(error));
    }
  }

  throw lastError || new Error("Recap မအောင်မြင်ပါ။");
}

// WAV utilities

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

async function generateSpeechWithModel(ai, text, output, model) {
  const response = await ai.models.generateContent({
    model,
    contents: [{
      role: "user",
      parts: [{
        text:
          "Speak this Burmese text exactly as written. " +
          "Do not translate it. Do not add English words. " +
          "Use natural Myanmar pronunciation, warm documentary " +
          "storytelling voice, clear articulation and moderate pace.\n\n" +
          text
      }]
    }],
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

  const part = response.candidates?.[0]?.content?.parts?.find(
    p => p.inlineData?.data
  );

  if (!part) {
    throw new Error(`TTS ${model}: အသံမရပါ။`);
  }

  const buffer = Buffer.from(part.inlineData.data, "base64");

  if (!buffer.length) {
    throw new Error("TTS အသံဖိုင် ဗလာဖြစ်နေပါတယ်။");
  }

  const mime = part.inlineData.mimeType || "";

  if (mime.includes("wav") || buffer.toString("ascii", 0, 4) === "RIFF") {
    await fsp.writeFile(output, buffer);
  } else {
    const rate = Number(mime.match(/rate=(\d+)/i)?.[1] || 24000);
    await fsp.writeFile(output, createWavBuffer(buffer, rate));
  }

  return model;
}

async function generateSpeech(ai, text, output) {
  if (!hasMyanmar(text)) {
    throw new Error("မြန်မာစာမဟုတ်သော Narration ကို TTS မလုပ်ပါ။");
  }

  const models = [...new Set([TTS_MODEL, ...TTS_FALLBACKS])];
  let lastError;

  for (const model of models) {
    try {
      return await retry(
        () => generateSpeechWithModel(ai, text, output, model),
        `VOICE ${model}`,
        3
      );
    } catch (error) {
      lastError = error;
      await safeUnlink(output);
    }
  }

  throw new Error(
    "မြန်မာအသံဖန်တီးမှု မအောင်မြင်ပါ။ " + message(lastError)
  );
}

async function combineWavFiles(files, output) {
  if (!files.length) {
    throw new Error("အသံဖိုင် မရှိပါ။");
  }

  const command = ffmpeg();
  files.forEach(file => command.input(file));

  const labels = files.map((_, i) => `[${i}:a:0]`).join("");
  const filter =
    `${labels}concat=n=${files.length}:v=0:a=1[out]`;

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

// Upload

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
      return cb(new Error("MP4, MOV, MKV, WEBM, AVI, M4V ဖိုင်သာ လက်ခံသည်။"));
    }

    cb(null, true);
  }
});

// Health

app.get("/", (req, res) => {
  res.json({
    success: true,
    service: "HWA Burmese Auto Recap",
    version: "6.0.0",
    status: "OK"
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    status: "OK",
    version: "6.0.0",
    ffmpeg: Boolean(ffmpegPath),
    ffprobe: Boolean(ffprobePath),
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
    recapModel: RECAP_MODEL,
    ttsModel: TTS_MODEL,
    ttsVoice: TTS_VOICE,
    maxUploadSize: MAX_UPLOAD_SIZE,
    maxVideoDuration: MAX_VIDEO_DURATION,
    editSettings: false,
    originalAudio: false,
    timestampedRecap: true
  });
});

// Upload video

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

    if (info.duration <= 0) {
      throw new Error("Video ကြာချိန် မသိရှိနိုင်ပါ။");
    }

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
      stage: "Video Upload အောင်မြင်ပါပြီ။",
      originalName: req.file.originalname,
      filePath,
      fileSize: req.file.size,
      videoInfo: info,

      recapStatus: "not_started",
      recapScript: null,
      segments: [],

      voiceStatus: "not_started",
      voiceFile: null,
      voiceUrl: null,
      segmentVoiceFiles: [],

      renderStatus: "not_started",
      outputFile: null,
      outputUrl: null,
      outputInfo: null,

      error: null
    };

    jobs.set(id, job);

    res.status(201).json({
      success: true,
      message: "Video Upload အောင်မြင်ပါပြီ။",
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
      message: message(error)
    });
  }
});

// Timestamped recap

app.post("/api/jobs/:id/recap", async (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({
      success: false,
      message: "Job မတွေ့ပါ။"
    });
  }

  if (!fs.existsSync(job.filePath)) {
    return res.status(404).json({
      success: false,
      message: "Video ဖိုင် မတွေ့ပါ။"
    });
  }

  if (job.recapStatus === "processing") {
    return res.status(409).json({
      success: false,
      message: "Recap လုပ်နေဆဲပါ။"
    });
  }

  try {
    job.recapStatus = "processing";
    job.status = "recapping";
    job.progress = 10;
    job.stage = "Movie တစ်ကားလုံးကို ဆန်းစစ်နေပါတယ်။";
    job.error = null;

    const ai = await getAIClient();
    const file = await uploadToGemini(ai, job);

    job.progress = 35;
    job.stage = "ဇာတ်ကွက်များကို Timestamp အလိုက် ခွဲနေပါတယ်။";

    const result = await generateTimestampedRecap(ai, file, job);

    job.segments = result.segments;
    job.recapScript = joinNarration(result.segments);
    job.recapModel = result.model;

    job.recapStatus = "completed";
    job.status = "ready";
    job.progress = 50;
    job.stage = `မြန်မာ Recap အပိုင်း ${job.segments.length} ခု ရပါပြီ။`;

    res.json({
      success: true,
      usedModel: result.model,
      job: {
        id: job.id,
        recapStatus: job.recapStatus,
        recapScript: job.recapScript,
        segments: job.segments,
        segmentCount: job.segments.length,
        progress: job.progress,
        stage: job.stage
      }
    });
  } catch (error) {
    console.error("RECAP ERROR:", error);

    job.recapStatus = "failed";
    job.status = "error";
    job.error = message(error);

    res.status(500).json({
      success: false,
      message: job.error
    });
  }
});

// Generate Burmese voice for every segment

app.post("/api/jobs/:id/voice", async (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({
      success: false,
      message: "Job မတွေ့ပါ။"
    });
  }

  if (!job.segments?.length) {
    return res.status(400).json({
      success: false,
      message: "Timestamp Recap အရင်လုပ်ပါ။"
    });
  }

  if (job.voiceStatus === "processing") {
    return res.status(409).json({
      success: false,
      message: "Voice ဖန်တီးနေဆဲပါ။"
    });
  }

  const ai = await getAIClient();
  const voiceFiles = [];
  const usedModels = [];

  try {
    job.voiceStatus = "processing";
    job.status = "voicing";
    job.progress = 52;
    job.stage = "မြန်မာ AI Voice ပြုလုပ်နေပါတယ်။";
    job.error = null;

    for (let i = 0; i < job.segments.length; i++) {
      const segment = job.segments[i];

      const output = path.join(
        TEMP_DIR,
        `${job.id}-segment-${i + 1}.wav`
      );

      job.stage =
        `မြန်မာအသံ အပိုင်း ${i + 1}/${job.segments.length} ဖန်တီးနေပါတယ်။`;

      const model = await generateSpeech(
        ai,
        segment.narration,
        output
      );

      voiceFiles.push(output);
      usedModels.push(model);

      job.progress = 52 + Math.round(
        ((i + 1) / job.segments.length) * 25
      );
    }

    const combinedName = `${job.id}-voice.wav`;
    const combinedFile = path.join(OUTPUT_DIR, combinedName);

    await combineWavFiles(voiceFiles, combinedFile);

    const audioInfo = await probeAudio(combinedFile);

    job.segmentVoiceFiles = voiceFiles;
    job.voiceFile = combinedFile;
    job.voiceUrl = publicUrl(req, combinedName);
    job.voiceStatus = "completed";
    job.status = "ready";
    job.progress = 80;
    job.stage = "မြန်မာအသံ အပိုင်းအားလုံး အဆင်သင့်ဖြစ်ပါပြီ။";
    job.ttsModelsUsed = [...new Set(usedModels)];

    // Save generated voice file references in job.

    res.json({
      success: true,
      job: {
        id: job.id,
        voiceStatus: job.voiceStatus,
        voiceUrl: job.voiceUrl,
        audioInfo,
        segmentVoiceCount: voiceFiles.length,
        usedModels: job.ttsModelsUsed,
        progress: job.progress,
        stage: job.stage
      }
    });
  } catch (error) {
    console.error("VOICE ERROR:", error);

    for (const file of voiceFiles) {
      await safeUnlink(file);
    }

    job.segmentVoiceFiles = [];
    job.voiceStatus = "failed";
    job.status = "error";
    job.error = message(error);

    res.status(500).json({
      success: false,
      message: job.error
    });
  }
});

// Automatic segment-by-segment render.
// Original movie audio is NEVER mapped into the output.

app.post("/api/jobs/:id/render", async (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({
      success: false,
      message: "Job မတွေ့ပါ။"
    });
  }

  if (!job.segments?.length || !job.segmentVoiceFiles?.length) {
    return res.status(400).json({
      success: false,
      message: "Recap နဲ့ Voice အရင်ပြီးစီးရပါမယ်။"
    });
  }

  if (job.renderStatus === "processing") {
    return res.status(409).json({
      success: false,
      message: "Render လုပ်နေဆဲပါ။"
    });
  }

  const command = ffmpeg();
  const filters = [];
  const concatInputs = [];
  let expectedDuration = 0;

  try {
    job.renderStatus = "processing";
    job.status = "rendering";
    job.progress = 82;
    job.stage = "သက်ဆိုင်ရာ ရုပ်ကွက်နဲ့ မြန်မာအသံကို ချိတ်ဆက်နေပါတယ်။";
    job.error = null;

    const segments = job.segments;

    if (segments.length !== job.segmentVoiceFiles.length) {
      throw new Error("Video အပိုင်းနဲ့ Voice အပိုင်း အရေအတွက် မတူပါ။");
    }

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const voiceFile = job.segmentVoiceFiles[i];

      if (!fs.existsSync(voiceFile)) {
        throw new Error(`Voice အပိုင်း ${i + 1} မတွေ့ပါ။`);
      }

      const voiceInfo = await probeAudio(voiceFile);

      const clipDuration = segment.end - segment.start;
      const voiceDuration = voiceInfo.duration;

      if (clipDuration <= 0 || voiceDuration <= 0) {
        throw new Error(`အပိုင်း ${i + 1} ကြာချိန် မမှန်ပါ။`);
      }

      // Keep both narration and matching footage.
      // If narration is longer, hold the last video frame.
      // If footage is longer, pad the narration with silence.
      const targetDuration = Math.max(
        clipDuration,
        voiceDuration
      );

      expectedDuration += targetDuration;

      command
        .input(job.filePath)
        .inputOptions([
          "-ss", String(segment.start),
          "-t", String(clipDuration)
        ]);

      command.input(voiceFile);

      const videoInput = i * 2;
      const audioInput = i * 2 + 1;

      const extraVideo = Math.max(
        0,
        targetDuration - clipDuration
      );

      let videoChain =
        `[${videoInput}:v:0]` +
        `setpts=PTS-STARTPTS,` +
        `scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1`;

      if (extraVideo > 0.05) {
        videoChain +=
          `,tpad=stop_mode=clone:stop_duration=${extraVideo}`;
      }

      videoChain +=
        `,trim=duration=${targetDuration},` +
        `setpts=PTS-STARTPTS[v${i}]`;

      filters.push(videoChain);

      filters.push(
        `[${audioInput}:a:0]` +
        `aresample=48000,` +
        `apad,` +
        `atrim=duration=${targetDuration},` +
        `asetpts=PTS-STARTPTS[a${i}]`
      );

      concatInputs.push(`[v${i}][a${i}]`);

      job.progress = 82 + Math.round(
        ((i + 1) / segments.length) * 10
      );

      job.stage =
        `ရုပ်နဲ့အသံ အပိုင်း ${i + 1}/${segments.length} ချိန်ညှိနေပါတယ်။`;
    }

    filters.push(
      `${concatInputs.join("")}` +
      `concat=n=${segments.length}:v=1:a=1[vout][aout]`
    );

    const filename = `${job.id}-hwa-final.mp4`;
    const output = path.join(OUTPUT_DIR, filename);

    job.stage = "မူရင်းအသံမပါသော မြန်မာ Recap MP4 Render လုပ်နေပါတယ်။";

    await runFFmpeg(
      command
        .complexFilter(filters)
        .outputOptions([
          "-map [vout]",
          "-map [aout]",
          "-c:v libx264",
          "-preset veryfast",
          "-crf 22",
          "-pix_fmt yuv420p",
          "-c:a aac",
          "-b:a 192k",
          "-ar 48000",
          "-movflags +faststart",
          "-t", String(expectedDuration)
        ])
        .output(output)
    );

    if (!fs.existsSync(output) || fs.statSync(output).size === 0) {
      throw new Error("MP4 ဖိုင် မထွက်လာပါ။");
    }

    const outputInfo = await probe(output);

    job.outputFile = output;
    job.outputUrl = publicUrl(req, filename);
    job.outputInfo = outputInfo;

    job.renderStatus = "completed";
    job.status = "ready";
    job.progress = 100;
    job.stage = "HWA Burmese Recap MP4 အောင်မြင်ပါပြီ။";

    res.json({
      success: true,
      message: "မြန်မာအသံနဲ့ Auto Sync လုပ်ထားသော MP4 အဆင်သင့်ဖြစ်ပါပြီ။",
      job: {
        id: job.id,
        renderStatus: job.renderStatus,
        outputUrl: job.outputUrl,
        outputInfo,
        originalAudioIncluded: false,
        progress: 100,
        stage: job.stage
      }
    });
  } catch (error) {
    console.error("RENDER ERROR:", error);

    job.renderStatus = "failed";
    job.status = "error";
    job.error = message(error);

    res.status(500).json({
      success: false,
      message: job.error
    });
  }
});

// Job status

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({
      success: false,
      message: "Job မတွေ့ပါ။"
    });
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
      segments: job.segments,

      voiceStatus: job.voiceStatus,
      voiceUrl: job.voiceUrl,

      renderStatus: job.renderStatus,
      outputUrl: job.outputUrl,
      outputInfo: job.outputInfo,

      originalAudioIncluded: false,
      error: job.error
    }
  });
});

// Delete job and its files

app.delete("/api/jobs/:id", async (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({
      success: false,
      message: "Job မတွေ့ပါ။"
    });
  }

  const files = [
    job.filePath,
    job.voiceFile,
    job.outputFile,
    ...(job.segmentVoiceFiles || [])
  ];

  await Promise.all(files.map(safeUnlink));

  jobs.delete(req.params.id);

  res.json({
    success: true,
    message: "Job နဲ့ ဆက်စပ်ဖိုင်များ ဖျက်ပြီးပါပြီ။"
  });
});

// Error handler

app.use((error, req, res, next) => {
  console.error("SERVER ERROR:", error);

  if (error instanceof multer.MulterError) {
    return res.status(
      error.code === "LIMIT_FILE_SIZE" ? 413 : 400
    ).json({
      success: false,
      message:
        error.code === "LIMIT_FILE_SIZE"
          ? "Video ဖိုင်အရွယ်အစား 1GB ကျော်နေပါတယ်။"
          : error.message
    });
  }

  res.status(400).json({
    success: false,
    message: message(error)
  });
});

// Start server

app.listen(PORT, "0.0.0.0", () => {
  console.log("====================================");
  console.log("HWA BURMESE AUTO RECAP");
  console.log("Version: 6.0.0");
  console.log("Original audio: OFF");
  console.log("Edit settings: HIDDEN / AUTO");
  console.log("Timestamp sync: ON");
  console.log("Port:", PORT);
  console.log("====================================");
});
