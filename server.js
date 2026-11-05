
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const fsp = fs.promises;
const crypto = require("crypto");
const { spawn } = require("child_process");

const { GoogleGenAI } = require("@google/genai");
const ffmpegPath = require("ffmpeg-static");
const ffprobePath = require("ffprobe-static").path;

// ========================================
// HWA EDITOR CONFIGURATION
// ========================================

const app = express();

const PORT = process.env.PORT || 10000;

const ROOT = __dirname;
const UPLOAD_DIR = path.join(ROOT, "uploads");
const OUTPUT_DIR = path.join(ROOT, "outputs");
const TEMP_DIR = path.join(ROOT, "temp");

const MAX_UPLOAD_SIZE =
  Number(process.env.MAX_UPLOAD_SIZE) || 1024 * 1024 * 1024;

const MAX_VIDEO_DURATION =
  Number(process.env.MAX_VIDEO_DURATION) || 350 * 60;

const RECAP_MODEL =
  process.env.GEMINI_MODEL || "gemini-2.5-flash";

const TTS_MODEL =
  process.env.GEMINI_TTS_MODEL ||
  "gemini-2.5-flash-preview-tts";

const TTS_FALLBACK_MODELS = (
  process.env.GEMINI_TTS_FALLBACK_MODELS ||
  "gemini-2.5-pro-preview-tts"
).split(",").map(x => x.trim()).filter(Boolean);

const TTS_VOICE =
  process.env.GEMINI_TTS_VOICE || "Kore";

const jobs = new Map();

let ai = null;

for (const folder of [UPLOAD_DIR, OUTPUT_DIR, TEMP_DIR]) {
  fs.mkdirSync(folder, { recursive: true });
}

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use("/outputs", express.static(OUTPUT_DIR));

// ========================================
// GEMINI CLIENT
// ========================================

function getAI() {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error(
      "GEMINI_API_KEY မရှိပါ။ Render Environment ထဲမှာ ထည့်ပါ။"
    );
  }

  if (!ai) {
    ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY
    });
  }

  return ai;
}

// ========================================
// JOB HELPERS
// ========================================

function updateJob(job, data) {
  Object.assign(job, data, {
    updatedAt: Date.now()
  });
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    message: job.message,
    videoDuration: job.videoDuration,
    recapScript: job.recapScript || "",
    segments: job.segments || [],
    voiceUrl: job.voiceUrl || null,
    outputUrl: job.outputUrl || null,
    error: job.error || null
  };
}

function getJob(id) {
  return jobs.get(id);
}

// ========================================
// COMMAND RUNNER
// ========================================

function runCommand(command, args, timeout = 7200000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "ignore", "pipe"]
    });

    let stderr = "";
    let finished = false;

    const timer = setTimeout(() => {
      if (!finished) {
        child.kill("SIGKILL");
        finished = true;
        reject(new Error("လုပ်ဆောင်ချိန်ကျော်လွန်သွားပါတယ်။"));
      }
    }, timeout);

    child.stderr.on("data", data => {
      stderr += data.toString();

      if (stderr.length > 15000) {
        stderr = stderr.slice(-15000);
      }
    });

    child.on("error", error => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", code => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);

      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr || `Process failed: ${code}`));
      }
    });
  });
}

// ========================================
// VIDEO INFORMATION
// ========================================

async function getVideoInfo(filePath) {
  return new Promise((resolve, reject) => {
    const args = [
      "-v", "error",
      "-show_entries",
      "format=duration:stream=codec_type,width,height",
      "-of", "json",
      filePath
    ];

    const child = spawn(ffprobePath, args);

    let output = "";
    let errorText = "";

    child.stdout.on("data", data => {
      output += data.toString();
    });

    child.stderr.on("data", data => {
      errorText += data.toString();
    });

    child.on("error", reject);

    child.on("close", code => {
      if (code !== 0) {
        return reject(
          new Error(errorText || "Video ဖိုင်ကို ဖတ်မရပါ။")
        );
      }

      try {
        resolve(JSON.parse(output));
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function getMediaDuration(filePath) {
  const info = await getVideoInfo(filePath);
  const duration = Number(info.format?.duration);

  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("Media Duration မဖတ်နိုင်ပါ။");
  }

  return duration;
}

// ========================================
// FILE UPLOAD
// ========================================

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },

  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "") || ".mp4";
    cb(null, crypto.randomUUID() + ext);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: MAX_UPLOAD_SIZE
  },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();

    const allowedExtensions = [
      ".mp4", ".mov", ".mkv", ".webm",
      ".avi", ".m4v", ".3gp"
    ];

    if (
      !file.mimetype.startsWith("video/") &&
      !allowedExtensions.includes(ext)
    ) {
      return cb(
        new Error("Video ဖိုင်ကိုသာ Upload လုပ်နိုင်ပါတယ်။")
      );
    }

    cb(null, true);
  }
});

// ========================================
// JSON PARSER
// ========================================

function extractJSON(text) {
  const cleaned = String(text || "")
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");

  if (start === -1 || end === -1) {
    throw new Error("AI Recap JSON မရရှိပါ။");
  }

  return JSON.parse(cleaned.slice(start, end + 1));
}

function isMyanmarText(text) {
  return /[\u1000-\u109F]/.test(text || "");
}

function parseSegments(data, duration) {
  if (!Array.isArray(data?.segments)) {
    throw new Error("Recap segments မတွေ့ပါ။");
  }

  const segments = data.segments
    .map(item => ({
      start: Number(item.start),
      end: Number(item.end),
      narration: String(item.narration || "").trim()
    }))
    .filter(item =>
      Number.isFinite(item.start) &&
      Number.isFinite(item.end) &&
      item.start >= 0 &&
      item.end > item.start &&
      item.start < duration &&
      item.narration.length > 0 &&
      isMyanmarText(item.narration)
    )
    .map(item => ({
      ...item,
      end: Math.min(item.end, duration)
    }))
    .sort((a, b) => a.start - b.start);

  if (segments.length === 0) {
    throw new Error("မြန်မာ Recap စာသား မတွေ့ပါ။");
  }

  if (segments.length > 180) {
    throw new Error("Recap အပိုင်း 180 ထက် များနေပါတယ်။");
  }

  // Overlapping timestamps are not accepted.
  for (let i = 1; i < segments.length; i++) {
    if (segments[i].start < segments[i - 1].end) {
      segments[i].start = segments[i - 1].end;
    }

    if (segments[i].end <= segments[i].start) {
      throw new Error("Recap Timestamp မမှန်ပါ။");
    }
  }

  return segments;
}

// ========================================
// RECAP PROMPT
// ========================================

function buildRecapPrompt(duration) {
  return `
You are a professional movie analysis and recap writer.

Analyze the uploaded movie carefully.

Your task is to create a detailed Burmese movie recap
from the beginning to the ending.

STRICT RULES:

1. All narration must be written in natural Burmese.
2. Do not write English narration.
3. Follow the real chronological order of the movie.
4. Cover the important events from beginning to ending.
5. Include important conversations and explain their meanings
   naturally in Burmese.
6. Include character relationships and motivations.
7. Explain conflicts, decisions, reveals and plot twists.
8. Do not invent scenes or events.
9. Do not copy long original movie dialogue.
10. Do not skip important story developments.
11. Use timestamps in seconds from the beginning of the video.
12. Each segment must describe the corresponding part of the movie.
13. Use approximately 20 to 60 seconds per narration segment
    when appropriate.
14. Do not create timestamps outside the video duration.

Video duration: ${duration} seconds.

Return only valid JSON:

{
  "segments": [
    {
      "start": 0,
      "end": 40,
      "narration": "မြန်မာဘာသာဖြင့် ဇာတ်ကြောင်းပြောစာသား"
    }
  ]
}

All narration must contain Burmese Unicode.
`;
}

// ========================================
// GEMINI FILE PROCESSING
// ========================================

async function waitForGeminiFile(client, fileName) {
  for (let i = 0; i < 90; i++) {
    const file = await client.files.get({
      name: fileName
    });

    if (file.state === "ACTIVE") {
      return file;
    }

    if (file.state === "FAILED") {
      throw new Error("Gemini Video Processing မအောင်မြင်ပါ။");
    }

    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  throw new Error("Gemini Video Processing အချိန်ကျော်သွားပါတယ်။");
}

// ========================================
// TTS AUDIO HELPERS
// ========================================

function pcmToWav(pcm, sampleRate = 24000, channels = 1) {
  const header = Buffer.alloc(44);

  const byteRate = sampleRate * channels * 2;
  const blockAlign = channels * 2;

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

function getAudioPart(response) {
  const parts = response.candidates?.[0]?.content?.parts || [];

  const audioPart = parts.find(
    part => part.inlineData?.data
  );

  if (!audioPart) {
    throw new Error("AI Voice Audio Data မရရှိပါ။");
  }

  return audioPart.inlineData;
}

async function generateVoice(text) {
  const client = getAI();

  const models = [
    TTS_MODEL,
    ...TTS_FALLBACK_MODELS
  ];

  let lastError = null;

  for (const model of models) {
    try {
      const response = await client.models.generateContent({
        model,
        contents: [{
          role: "user",
          parts: [{
            text:
              "အောက်ပါ မြန်မာစာကို သဘာဝကျသော " +
              "မြန်မာဇာတ်ကြောင်းပြောသံဖြင့် ဖတ်ပေးပါ။ " +
              "စာသားကို မပြောင်းပါနှင့်။\n\n" + text
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

      const audio = getAudioPart(response);
      const mimeType = audio.mimeType || "audio/L16";

      if (
        mimeType.includes("wav") ||
        mimeType.includes("mpeg") ||
        mimeType.includes("mp3")
      ) {
        return Buffer.from(audio.data, "base64");
      }

      const rateMatch = mimeType.match(/rate=(\d+)/i);
      const sampleRate = rateMatch
        ? Number(rateMatch[1])
        : 24000;

      const pcm = Buffer.from(audio.data, "base64");

      return pcmToWav(pcm, sampleRate, 1);

    } catch (error) {
      lastError = error;

      console.error(
        `TTS model ${model} failed:`,
        error.message
      );
    }
  }

  throw new Error(
    "မြန်မာ AI Voice မထုတ်နိုင်ပါ။ Model သို့မဟုတ် API ပြဿနာ: " +
    (lastError?.message || "Unknown error")
  );
}

// ========================================
// HEALTH CHECK
// ========================================

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    status: "OK",
    app: "HWA EDITOR",
    version: "6.1.0",
    originalAudio: false,
    editSettings: false,
    timestampedRecap: true
  });
});

// ========================================
// UPLOAD VIDEO API
// ========================================

app.post("/api/upload", (req, res) => {
  upload.single("video")(req, res, async error => {
    if (error) {
      return res.status(400).json({
        success: false,
        error: error.message
      });
    }

    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: "Video ဖိုင် မတွေ့ပါ။"
        });
      }

      const info = await getVideoInfo(req.file.path);
      const duration = Number(info.format?.duration);

      if (!Number.isFinite(duration) || duration <= 0) {
        await fsp.unlink(req.file.path).catch(() => {});

        return res.status(400).json({
          success: false,
          error: "Video Duration မဖတ်နိုင်ပါ။"
        });
      }

      if (duration > MAX_VIDEO_DURATION) {
        await fsp.unlink(req.file.path).catch(() => {});

        return res.status(400).json({
          success: false,
          error: "Video သည် 350 မိနစ်ထက် ကျော်နေပါတယ်။"
        });
      }

      const id = crypto.randomUUID();

      const job = {
        id,
        filePath: req.file.path,
        originalName: req.file.originalname,
        videoDuration: duration,

        status: "uploaded",
        stage: "uploaded",
        progress: 5,
        message: "Video Upload အောင်မြင်ပါပြီ။",

        recapScript: "",
        segments: [],
        voiceFiles: [],
        voicePath: null,
        outputUrl: null,
        error: null,

        createdAt: Date.now(),
        updatedAt: Date.now()
      };

      jobs.set(id, job);

      res.json({
        success: true,
        job: publicJob(job)
      });

    } catch (err) {
      console.error("UPLOAD ERROR:", err);

      if (req.file?.path) {
        await fsp.unlink(req.file.path).catch(() => {});
      }

      res.status(500).json({
        success: false,
        error: err.message
      });
    }
  });
});

// ========================================
// GENERATE BURMESE RECAP API
// ========================================

app.post("/api/jobs/:id/recap", async (req, res) => {
  const job = getJob(req.params.id);

  if (!job) {
    return res.status(404).json({
      success: false,
      error: "Job မတွေ့ပါ။"
    });
  }

  try {
    updateJob(job, {
      status: "processing",
      stage: "recap",
      progress: 10,
      message: "AI က ရုပ်ရှင်တစ်ကားလုံးကို လေ့လာနေပါတယ်။",
      error: null
    });

    const client = getAI();

    const uploaded = await client.files.upload({
      file: job.filePath,
      config: {
        mimeType: "video/mp4"
      }
    });

    if (!uploaded.name || !uploaded.uri) {
      throw new Error("Gemini Video Upload မအောင်မြင်ပါ။");
    }

    const activeFile = await waitForGeminiFile(
      client,
      uploaded.name
    );

    updateJob(job, {
      progress: 25,
      message: "မြန်မာ Recap စာသား ရေးသားနေပါတယ်။"
    });

    const response = await client.models.generateContent({
      model: RECAP_MODEL,
      contents: [{
        role: "user",
        parts: [
          {
            text: buildRecapPrompt(job.videoDuration)
          },
          {
            fileData: {
              fileUri: activeFile.uri,
              mimeType: activeFile.mimeType || "video/mp4"
            }
          }
        ]
      }],
      config: {
        responseMimeType: "application/json"
      }
    });

    const responseText =
      typeof response.text === "function"
        ? response.text()
        : response.text;

    const data = extractJSON(responseText);

    const segments = parseSegments(
      data,
      job.videoDuration
    );

    job.segments = segments;

    job.recapScript = segments
      .map(segment => segment.narration)
      .join("\n\n");

    updateJob(job, {
      status: "recap_done",
      stage: "recap_done",
      progress: 40,
      message: "မြန်မာ Recap အောင်မြင်ပါပြီ။"
    });

    res.json({
      success: true,
      job: publicJob(job)
    });

  } catch (error) {
    console.error("RECAP ERROR:", error);

    updateJob(job, {
      status: "error",
      stage: "recap",
      error: error.message,
      message: "Recap ပြုလုပ်ရာတွင် အမှားဖြစ်နေပါတယ်။"
    });

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ========================================
// GENERATE BURMESE VOICE API
// ========================================

app.post("/api/jobs/:id/voice", async (req, res) => {
  const job = getJob(req.params.id);

  if (!job) {
    return res.status(404).json({
      success: false,
      error: "Job မတွေ့ပါ။"
    });
  }

  try {
    if (!job.segments || job.segments.length === 0) {
      throw new Error("Recap အရင်ပြုလုပ်ပေးပါ။");
    }

    updateJob(job, {
      status: "processing",
      stage: "voice",
      progress: 45,
      message: "မြန်မာ AI Voice ထုတ်လုပ်နေပါတယ်။",
      error: null
    });

    const voiceDir = path.join(TEMP_DIR, job.id);

    await fsp.mkdir(voiceDir, {
      recursive: true
    });

    job.voiceFiles = [];

    for (let i = 0; i < job.segments.length; i++) {
      const segment = job.segments[i];

      updateJob(job, {
        progress: 45 + Math.round(
          ((i + 1) / job.segments.length) * 25
        ),
        message:
          `မြန်မာအသံ အပိုင်း ${i + 1}/` +
          `${job.segments.length} ထုတ်လုပ်နေပါတယ်။`
      });

      const wav = await generateVoice(segment.narration);

      const voicePath = path.join(
        voiceDir,
        `voice-${i}.wav`
      );

      await fsp.writeFile(voicePath, wav);

      job.voiceFiles.push(voicePath);
      segment.voiceIndex = i;
    }

    const combinedPath = path.join(
      voiceDir,
      "combined.wav"
    );

    const listPath = path.join(
      voiceDir,
      "voice-list.txt"
    );

    const listContent = job.voiceFiles
      .map(file => {
        return `file '${file.replace(/'/g, "'\\''")}'`;
      })
      .join("\n");

    await fsp.writeFile(listPath, listContent);

    await runCommand(ffmpegPath, [
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", listPath,
      "-c:a", "pcm_s16le",
      combinedPath
    ]);

    job.voicePath = combinedPath;

    updateJob(job, {
      status: "voice_done",
      stage: "voice_done",
      progress: 75,
      message: "မြန်မာ AI Voice အောင်မြင်ပါပြီ။"
    });

    res.json({
      success: true,
      job: publicJob(job)
    });

  } catch (error) {
    console.error("VOICE ERROR:", error);

    updateJob(job, {
      status: "error",
      stage: "voice",
      error: error.message,
      message: "AI Voice ထုတ်လုပ်ရာတွင် အမှားဖြစ်နေပါတယ်။"
    });

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ========================================
// RENDER ONE VIDEO SEGMENT
// ========================================

async function renderOneSegment(
  job,
  segment,
  voicePath,
  index,
  total,
  outputPath
) {
  const clipDuration = segment.end - segment.start;

  if (clipDuration <= 0) {
    throw new Error(`Video Segment ${index + 1} Timestamp မမှန်ပါ။`);
  }

  const voiceDuration = await getMediaDuration(voicePath);

  const targetDuration = Math.max(
    clipDuration,
    voiceDuration
  );

  const extraVideoTime = Math.max(
    0,
    targetDuration - clipDuration
  );

  const filter = [
    `[0:v]` +
    `setpts=PTS-STARTPTS,` +
    `scale=1280:720:force_original_aspect_ratio=decrease,` +
    `pad=1280:720:(ow-iw)/2:(oh-ih)/2,` +
    `setsar=1,fps=30,format=yuv420p,` +
    `tpad=stop_mode=clone:stop_duration=${extraVideoTime},` +
    `trim=duration=${targetDuration},` +
    `setpts=PTS-STARTPTS[v]`,

    `[1:a]` +
    `aresample=48000,` +
    `aformat=sample_fmts=fltp:channel_layouts=stereo,` +
    `apad,atrim=duration=${targetDuration},` +
    `asetpts=PTS-STARTPTS[a]`
  ].join(";");

  const args = [
    "-y",

    "-ss", String(segment.start),
    "-i", job.filePath,

    "-i", voicePath,

    "-filter_complex", filter,

    "-map", "[v]",
    "-map", "[a]",

    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    "-pix_fmt", "yuv420p",

    "-c:a", "aac",
    "-b:a", "192k",

    "-t", String(targetDuration),
    "-movflags", "+faststart",

    outputPath
  ];

  await runCommand(ffmpegPath, args, 7200000);

  updateJob(job, {
    progress: 85 + Math.round(
      ((index + 1) / total) * 10
    ),
    message: `Video အပိုင်း ${index + 1}/${total} Render လုပ်နေပါတယ်။`
  });
}

// ========================================
// FINAL MP4 RENDER API
// ========================================

app.post("/api/jobs/:id/render", async (req, res) => {
  const job = getJob(req.params.id);

  if (!job) {
    return res.status(404).json({
      success: false,
      error: "Job မတွေ့ပါ။"
    });
  }

  try {
    if (
      !job.segments?.length ||
      !job.voiceFiles?.length
    ) {
      throw new Error("Recap နှင့် Voice အရင်ပြီးအောင်လုပ်ပါ။");
    }

    if (job.segments.length !== job.voiceFiles.length) {
      throw new Error("Recap နဲ့ Voice အပိုင်းအရေအတွက် မကိုက်ညီပါ။");
    }

    updateJob(job, {
      status: "rendering",
      stage: "render",
      progress: 78,
      message: "Video နဲ့ မြန်မာအသံကို တွဲနေပါတယ်။",
      error: null
    });

    const renderDir = path.join(
      TEMP_DIR,
      job.id,
      "render"
    );

    await fsp.mkdir(renderDir, {
      recursive: true
    });

    const renderedSegments = [];

    for (let i = 0; i < job.segments.length; i++) {
      const outputPath = path.join(
        renderDir,
        `segment-${String(i).padStart(4, "0")}.mp4`
      );

      await renderOneSegment(
        job,
        job.segments[i],
        job.voiceFiles[i],
        i,
        job.segments.length,
        outputPath
      );

      renderedSegments.push(outputPath);
    }

    updateJob(job, {
      progress: 96,
      message: "MP4 အပိုင်းများကို ပေါင်းစည်းနေပါတယ်။"
    });

    const listPath = path.join(
      renderDir,
      "video-list.txt"
    );

    const listContent = renderedSegments
      .map(file => `file '${file.replace(/'/g, "'\\''")}'`)
      .join("\n");

    await fsp.writeFile(listPath, listContent);

    const outputPath = path.join(
      OUTPUT_DIR,
      `${job.id}.mp4`
    );

    await runCommand(ffmpegPath, [
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", listPath,
      "-c", "copy",
      "-movflags", "+faststart",
      outputPath
    ], 7200000);

    const stats = await fsp.stat(outputPath);

    if (stats.size <= 0) {
      throw new Error("MP4 Output ဖိုင် မထုတ်နိုင်ပါ။");
    }

    updateJob(job, {
      status: "completed",
      stage: "completed",
      progress: 100,
      outputUrl: `/outputs/${job.id}.mp4`,
      message: "MP4 Video အဆင်သင့်ဖြစ်ပါပြီ။"
    });

    res.json({
      success: true,
      job: publicJob(job)
    });

  } catch (error) {
    console.error("RENDER ERROR:", error);

    updateJob(job, {
      status: "error",
      stage: "render",
      error: error.message,
      message: "Video Render ပြုလုပ်ရာတွင် အမှားဖြစ်နေပါတယ်။"
    });

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ========================================
// GET JOB STATUS API
// ========================================

app.get("/api/jobs/:id", (req, res) => {
  const job = getJob(req.params.id);

  if (!job) {
    return res.status(404).json({
      success: false,
      error: "Job မတွေ့ပါ။"
    });
  }

  res.json({
    success: true,
    job: publicJob(job)
  });
});

// ========================================
// DELETE JOB API
// ========================================

app.delete("/api/jobs/:id", async (req, res) => {
  const job = getJob(req.params.id);

  if (!job) {
    return res.status(404).json({
      success: false,
      error: "Job မတွေ့ပါ။"
    });
  }

  try {
    const files = [
      job.filePath,
      job.voicePath,
      ...(job.voiceFiles || []),
      path.join(OUTPUT_DIR, `${job.id}.mp4`)
    ].filter(Boolean);

    for (const file of files) {
      await fsp.unlink(file).catch(() => {});
    }

    await fsp.rm(
      path.join(TEMP_DIR, job.id),
      {
        recursive: true,
        force: true
      }
    ).catch(() => {});

    jobs.delete(job.id);

    res.json({
      success: true,
      message: "Job ဖျက်ပြီးပါပြီ။"
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ========================================
// NOT FOUND
// ========================================

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "API Route မတွေ့ပါ။"
  });
});

// ========================================
// ERROR HANDLER
// ========================================

app.use((error, req, res, next) => {
  console.error("SERVER ERROR:", error);

  if (res.headersSent) {
    return next(error);
  }

  res.status(500).json({
    success: false,
    error: error.message || "Server Error"
  });
});

// ========================================
// START SERVER
// ========================================

app.listen(PORT, () => {
  console.log("----------------------------------");
  console.log("HWA EDITOR BACKEND");
  console.log("Version: 6.1.0");
  console.log(`Port: ${PORT}`);
  console.log("Original Video Audio: DISABLED");
  console.log("Burmese Recap: ENABLED");
  console.log("AI Voice: ENABLED");
  console.log("MP4 Rendering: ENABLED");
  console.log("----------------------------------");
});
