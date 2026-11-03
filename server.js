
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

const GEMINI_TTS_MODEL =
  process.env.GEMINI_TTS_MODEL || "gemini-3.8-flash-tts";

const GEMINI_TTS_VOICE =
  process.env.GEMINI_TTS_VOICE || "Kore";

const UPLOAD_DIR = path.join(__dirname, "uploads");
const OUTPUT_DIR = path.join(__dirname, "outputs");
const TEMP_DIR = path.join(__dirname, "temp");

for (const dir of [UPLOAD_DIR, OUTPUT_DIR, TEMP_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

app.use(express.json({ limit: "10mb" }));

app.use(
  cors({
    origin: process.env.FRONTEND_URL
      ? process.env.FRONTEND_URL.split(",")
      : "*",
    methods: ["GET", "POST", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"]
  })
);

// Serve generated audio and video files.
app.use("/outputs", express.static(OUTPUT_DIR));

// --------------------------------------------------
// JOB STORAGE
// --------------------------------------------------

const jobs = new Map();

// --------------------------------------------------
// HELPERS
// --------------------------------------------------

function getAI() {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not configured.");
  }

  const { GoogleGenAI } = require("@google/genai");

  return new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY
  });
}

function getAIClient() {
  return import("@google/genai").then(({ GoogleGenAI }) => {
    return new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY
    });
  });
}

function getVideoInfo(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);

      const videoStream = metadata.streams.find(
        stream => stream.codec_type === "video"
      );

      const audioStream = metadata.streams.find(
        stream => stream.codec_type === "audio"
      );

      if (!videoStream) {
        return reject(
          new Error("Uploaded file has no video stream.")
        );
      }

      const duration = Number(metadata.format.duration || 0);
      const width = Number(videoStream.width || 0);
      const height = Number(videoStream.height || 0);

      resolve({
        duration,
        width,
        height,
        resolution: `${width}x${height}`,
        frameRate: videoStream.r_frame_rate || "unknown",
        videoCodec: videoStream.codec_name || "unknown",
        audioCodec: audioStream ? audioStream.codec_name : null,
        hasAudio: Boolean(audioStream),
        fileSize: Number(metadata.format.size || 0),
        format: metadata.format.format_name || "unknown"
      });
    });
  });
}

function runFFmpeg(command) {
  return new Promise((resolve, reject) => {
    command
      .on("end", resolve)
      .on("error", reject)
      .run();
  });
}

function splitText(text, maxChars = 3000) {
  const normalized = text
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();

  if (!normalized) return [];

  const sentences = normalized.match(/[^။.!?]+[။.!?]?/g) || [
    normalized
  ];

  const chunks = [];
  let current = "";

  for (const sentence of sentences) {
    const part = sentence.trim();
    if (!part) continue;

    if (part.length > maxChars) {
      if (current) {
        chunks.push(current);
        current = "";
      }

      for (let i = 0; i < part.length; i += maxChars) {
        chunks.push(part.slice(i, i + maxChars));
      }

      continue;
    }

    if ((current + " " + part).trim().length > maxChars) {
      if (current) chunks.push(current);
      current = part;
    } else {
      current = (current + " " + part).trim();
    }
  }

  if (current) chunks.push(current);

  return chunks;
}

async function generateSpeech(ai, text, outputPath) {
  const response = await ai.models.generateContent({
    model: GEMINI_TTS_MODEL,

    contents: [
      {
        role: "user",
        parts: [
          {
            text,
            speechMetadata: {
              style:
                "Natural Burmese narration, clear pronunciation, " +
                "warm storytelling voice, moderate pace."
            }
          }
        ]
      }
    ],

    config: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          voice: GEMINI_TTS_VOICE
        }
      }
    }
  });

  const audioPart =
    response.candidates?.[0]?.content?.parts?.find(
      part => part.inlineData?.data
    );

  if (!audioPart) {
    throw new Error("Gemini TTS returned no audio data.");
  }

  const audioData = audioPart.inlineData.data;

  const audioBuffer = Buffer.isBuffer(audioData)
    ? audioData
    : Buffer.from(audioData, "base64");

  await fsp.writeFile(outputPath, audioBuffer);
}

async function combineWavFiles(files, outputPath) {
  if (!files.length) {
    throw new Error("No audio files to combine.");
  }

  if (files.length === 1) {
    await fsp.copyFile(files[0], outputPath);
    return;
  }

  const manifestPath = path.join(
    TEMP_DIR,
    `${crypto.randomUUID()}.txt`
  );

  const manifest = files
    .map(file => {
      const escaped = file.replace(/'/g, "'\\''");
      return `file '${escaped}'`;
    })
    .join("\n");

  await fsp.writeFile(manifestPath, manifest, "utf8");

  try {
    await runFFmpeg(
      ffmpeg()
        .input(manifestPath)
        .inputOptions(["-f concat", "-safe 0"])
        .outputOptions(["-c copy"])
        .output(outputPath)
    );
  } finally {
    if (fs.existsSync(manifestPath)) {
      await fsp.unlink(manifestPath);
    }
  }
}

function outputUrl(req, fileName) {
  return `${req.protocol}://${req.get("host")}/outputs/${fileName}`;
}

// --------------------------------------------------
// MULTER UPLOAD
// --------------------------------------------------

const storage = multer.diskStorage({
  destination(req, file, cb) {
    cb(null, UPLOAD_DIR);
  },

  filename(req, file, cb) {
    const id = crypto.randomUUID();
    const ext = path.extname(file.originalname).toLowerCase();

    cb(null, `${id}${ext}`);
  }
});

const allowedExtensions = [
  ".mp4",
  ".mov",
  ".mkv",
  ".webm",
  ".avi",
  ".m4v"
];

const upload = multer({
  storage,

  limits: {
    fileSize: MAX_UPLOAD_SIZE,
    files: 1
  },

  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();

    if (!allowedExtensions.includes(ext)) {
      return cb(
        new Error(
          "Unsupported format. Upload MP4, MOV, MKV, WEBM, AVI or M4V."
        )
      );
    }

    cb(null, true);
  }
});

// --------------------------------------------------
// HEALTH CHECK
// --------------------------------------------------

app.get("/", (req, res) => {
  res.json({
    success: true,
    service: "Burmese Auto Recap Backend",
    status: "OK",
    version: "2.0.0"
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    status: "OK",
    ffmpeg: Boolean(ffmpegPath),
    ffprobe: Boolean(ffprobePath),
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
    geminiModel: GEMINI_MODEL,
    ttsModel: GEMINI_TTS_MODEL,
    timestamp: new Date().toISOString()
  });
});

// --------------------------------------------------
// UPLOAD VIDEO
// --------------------------------------------------

app.post("/api/upload", upload.single("video"), async (req, res) => {
  let uploadedFilePath = null;

  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Please select a video file."
      });
    }

    uploadedFilePath = req.file.path;

    const jobId = crypto.randomUUID();

    const job = {
      id: jobId,
      status: "analyzing",
      progress: 0,
      stage: "Analyzing video",
      originalName: req.file.originalname,
      filePath: uploadedFilePath,
      fileSize: req.file.size,
      createdAt: new Date().toISOString(),

      videoInfo: null,

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

    jobs.set(jobId, job);

    const videoInfo = await getVideoInfo(uploadedFilePath);

    if (videoInfo.duration > MAX_VIDEO_DURATION) {
      fs.unlinkSync(uploadedFilePath);
      jobs.delete(jobId);

      return res.status(400).json({
        success: false,
        message: "Video duration exceeds the maximum allowed duration.",
        maxDuration: MAX_VIDEO_DURATION,
        actualDuration: videoInfo.duration
      });
    }

    job.videoInfo = videoInfo;
    job.status = "ready";
    job.progress = 5;
    job.stage = "Video ready";

    return res.status(201).json({
      success: true,
      message: "Video uploaded successfully.",

      job: {
        id: job.id,
        status: job.status,
        progress: job.progress,
        stage: job.stage,
        originalName: job.originalName,
        fileSize: job.fileSize,
        videoInfo: job.videoInfo,
        recapStatus: job.recapStatus
      }
    });
  } catch (error) {
    console.error("UPLOAD ERROR:", error);

    if (uploadedFilePath && fs.existsSync(uploadedFilePath)) {
      try {
        fs.unlinkSync(uploadedFilePath);
      } catch (_) {}
    }

    return res.status(500).json({
      success: false,
      message: error.message || "Video upload failed."
    });
  }
});

// --------------------------------------------------
// GEMINI RECAP
// --------------------------------------------------

app.post("/api/jobs/:id/recap", async (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({
      success: false,
      message: "Job not found."
    });
  }

  if (!job.filePath || !fs.existsSync(job.filePath)) {
    return res.status(404).json({
      success: false,
      message: "Uploaded video file is missing."
    });
  }

  if (job.recapStatus === "processing") {
    return res.status(409).json({
      success: false,
      message: "Recap is already processing."
    });
  }

  try {
    const ai = await getAIClient();

    job.status = "recapping";
    job.recapStatus = "processing";
    job.progress = 10;
    job.stage = "Uploading video to Gemini";
    job.error = null;

    const ext = path.extname(job.filePath).toLowerCase();

    const mimeTypes = {
      ".mp4": "video/mp4",
      ".mov": "video/quicktime",
      ".mkv": "video/x-matroska",
      ".webm": "video/webm",
      ".avi": "video/x-msvideo",
      ".m4v": "video/mp4"
    };

    const mimeType = mimeTypes[ext] || "video/mp4";

    let geminiFile = await ai.files.upload({
      file: job.filePath,
      config: {
        mimeType,
        displayName: job.originalName
      }
    });

    job.progress = 25;
    job.stage = "Gemini is preparing the video";

    const startedAt = Date.now();
    const timeout = 10 * 60 * 1000;

    while (geminiFile.state === "PROCESSING") {
      if (Date.now() - startedAt > timeout) {
        throw new Error("Gemini video processing timed out.");
      }

      await new Promise(resolve => setTimeout(resolve, 3000));

      geminiFile = await ai.files.get({
        name: geminiFile.name
      });
    }

    if (geminiFile.state === "FAILED") {
      throw new Error("Gemini could not process the video.");
    }

    job.progress = 45;
    job.stage = "AI is analyzing the story";

    const recapPrompt = `
You are an expert movie recap storyteller.

Analyze the uploaded video and write a detailed,
natural Burmese-language movie recap script.

Rules:
1. Write naturally and fluently in Burmese.
2. Explain the story in chronological order.
3. Include important characters and motivations.
4. Include conflicts and turning points.
5. Paraphrase meaningful conversations.
6. Explain the ending if visible.
7. Do not invent scenes, names, dialogue, or events.
8. Do not guess unclear details.
9. Preserve important story details.
10. Do not make the recap extremely short.
11. Use engaging narration suitable for a movie recap.
12. Do not add unrelated opinions or false claims.
13. Start with an engaging hook.
14. Return only the Burmese recap script.
`;

    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,

      contents: [
        {
          role: "user",
          parts: [
            {
              fileData: {
                fileUri: geminiFile.uri,
                mimeType: geminiFile.mimeType || mimeType
              }
            },
            {
              text: recapPrompt
            }
          ]
        }
      ]
    });

    const recapText = response.text;

    if (!recapText || !recapText.trim()) {
      throw new Error("Gemini returned an empty recap.");
    }

    job.recapScript = recapText.trim();
    job.recapStatus = "completed";
    job.status = "ready";
    job.progress = 50;
    job.stage = "Burmese recap script generated";

    return res.json({
      success: true,
      message: "Burmese recap script generated successfully.",
      job: {
        id: job.id,
        status: job.status,
        progress: job.progress,
        stage: job.stage,
        recapStatus: job.recapStatus,
        recapScript: job.recapScript
      }
    });
  } catch (error) {
    console.error("GEMINI RECAP ERROR:", error);

    job.recapStatus = "failed";
    job.status = "error";
    job.error = error.message || "AI recap failed.";
    job.stage = "AI recap failed";

    return res.status(500).json({
      success: false,
      message: job.error
    });
  }
});

// --------------------------------------------------
// GENERATE BURMESE VOICE
// --------------------------------------------------

app.post("/api/jobs/:id/voice", async (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({
      success: false,
      message: "Job not found."
    });
  }

  const text = String(
    req.body?.text || job.recapScript || ""
  ).trim();

  if (!text) {
    return res.status(400).json({
      success: false,
      message: "Recap script is empty."
    });
  }

  if (job.voiceStatus === "processing") {
    return res.status(409).json({
      success: false,
      message: "Voice generation is already processing."
    });
  }

  try {
    const ai = await getAIClient();

    job.voiceStatus = "processing";
    job.progress = 55;
    job.stage = "Generating Burmese AI voice";
    job.error = null;

    const chunks = splitText(text, 3000);

    if (!chunks.length) {
      throw new Error("No usable text was found.");
    }

    const chunkFiles = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunkPath = path.join(
        TEMP_DIR,
        `${job.id}-voice-${i}.wav`
      );

      await generateSpeech(ai, chunks[i], chunkPath);

      chunkFiles.push(chunkPath);

      job.progress = 55 + Math.round(
        ((i + 1) / chunks.length) * 25
      );

      job.stage =
        `Generating voice ${i + 1}/${chunks.length}`;
    }

    const voiceFileName = `${job.id}-voice.wav`;

    const voicePath = path.join(
      OUTPUT_DIR,
      voiceFileName
    );

    await combineWavFiles(chunkFiles, voicePath);

    for (const file of chunkFiles) {
      if (fs.existsSync(file)) {
        await fsp.unlink(file);
      }
    }

    job.voiceFile = voicePath;
    job.voiceUrl = outputUrl(req, voiceFileName);
    job.voiceStatus = "completed";
    job.progress = 80;
    job.stage = "Burmese voice generated";

    return res.json({
      success: true,
      message: "Burmese AI voice generated successfully.",
      job: {
        id: job.id,
        voiceStatus: job.voiceStatus,
        voiceUrl: job.voiceUrl,
        progress: job.progress,
        stage: job.stage
      }
    });
  } catch (error) {
    console.error("VOICE GENERATION ERROR:", error);

    job.voiceStatus = "failed";
    job.error = error.message || "Voice generation failed.";
    job.stage = "Voice generation failed";

    return res.status(500).json({
      success: false,
      message: job.error
    });
  }
});

// --------------------------------------------------
// RENDER MP4 WITH GENERATED VOICE
// --------------------------------------------------

app.post("/api/jobs/:id/render", async (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({
      success: false,
      message: "Job not found."
    });
  }

  if (!job.filePath || !fs.existsSync(job.filePath)) {
    return res.status(404).json({
      success: false,
      message: "Original video file is missing."
    });
  }

  if (!job.voiceFile || !fs.existsSync(job.voiceFile)) {
    return res.status(400).json({
      success: false,
      message: "Generate the Burmese voice before rendering."
    });
  }

  if (job.renderStatus === "processing") {
    return res.status(409).json({
      success: false,
      message: "Video rendering is already processing."
    });
  }

  try {
    job.renderStatus = "processing";
    job.status = "rendering";
    job.progress = 82;
    job.stage = "Combining video and Burmese voice";
    job.error = null;

    const outputFileName = `${job.id}-recap.mp4`;

    const outputPath = path.join(
      OUTPUT_DIR,
      outputFileName
    );

    await runFFmpeg(
      ffmpeg()
        .input(job.filePath)
        .input(job.voiceFile)
        .outputOptions([
          "-map 0:v:0",
          "-map 1:a:0",
          "-c:v copy",
          "-c:a aac",
          "-b:a 192k",
          "-shortest",
          "-movflags +faststart"
        ])
        .output(outputPath)
    );

    job.outputFile = outputPath;
    job.outputUrl = outputUrl(req, outputFileName);

    job.renderStatus = "completed";
    job.status = "ready";
    job.progress = 100;
    job.stage = "MP4 render completed";

    return res.json({
      success: true,
      message: "MP4 rendered successfully.",
      job: {
        id: job.id,
        renderStatus: job.renderStatus,
        outputUrl: job.outputUrl,
        progress: job.progress,
        stage: job.stage
      }
    });
  } catch (error) {
    console.error("RENDER ERROR:", error);

    job.renderStatus = "failed";
    job.status = "error";
    job.error = error.message || "Video rendering failed.";
    job.stage = "Video rendering failed";

    return res.status(500).json({
      success: false,
      message: job.error
    });
  }
});

// --------------------------------------------------
// GET JOB STATUS
// --------------------------------------------------

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({
      success: false,
      message: "Job not found."
    });
  }

  return res.json({
    success: true,

    job: {
      id: job.id,
      status: job.status,
      progress: job.progress,
      stage: job.stage,

      originalName: job.originalName,
      fileSize: job.fileSize,
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

// --------------------------------------------------
// DELETE JOB
// --------------------------------------------------

app.delete("/api/jobs/:id", async (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({
      success: false,
      message: "Job not found."
    });
  }

  try {
    const filesToDelete = [
      job.filePath,
      job.voiceFile,
      job.outputFile
    ];

    for (const file of filesToDelete) {
      if (file && fs.existsSync(file)) {
        await fsp.unlink(file);
      }
    }

    jobs.delete(req.params.id);

    return res.json({
      success: true,
      message: "Job deleted successfully."
    });
  } catch (error) {
    console.error("DELETE ERROR:", error);

    return res.status(500).json({
      success: false,
      message: "Could not delete job."
    });
  }
});

// --------------------------------------------------
// ERROR HANDLER
// --------------------------------------------------

app.use((err, req, res, next) => {
  console.error("SERVER ERROR:", err);

  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        success: false,
        message: "Video file is too large.",
        maxUploadSize: MAX_UPLOAD_SIZE
      });
    }

    return res.status(400).json({
      success: false,
      message: err.message
    });
  }

  return res.status(400).json({
    success: false,
    message: err.message || "Request failed."
  });
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

app.listen(PORT, "0.0.0.0", () => {
  console.log("--------------------------------------");
  console.log("Burmese Auto Recap Backend Started");
  console.log(`Port: ${PORT}`);
  console.log(`Upload Directory: ${UPLOAD_DIR}`);
  console.log(`Output Directory: ${OUTPUT_DIR}`);
  console.log(`Gemini Recap Model: ${GEMINI_MODEL}`);
  console.log(`Gemini TTS Model: ${GEMINI_TTS_MODEL}`);
  console.log("--------------------------------------");
});
