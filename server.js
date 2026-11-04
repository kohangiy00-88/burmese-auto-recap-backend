
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
)
  .split(",")
  .map(model => model.trim())
  .filter(Boolean);

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

if (!ffmpegPath) {
  throw new Error("FFmpeg binary was not found.");
}

if (!ffprobePath) {
  throw new Error("FFprobe binary was not found.");
}

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

// --------------------------------------------------
// EXPRESS CONFIGURATION
// --------------------------------------------------

app.use(express.json({ limit: "10mb" }));

app.use(
  cors({
    origin: process.env.FRONTEND_URL
      ? process.env.FRONTEND_URL.split(",").map(x => x.trim())
      : "*",
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"]
  })
);

app.use("/outputs", express.static(OUTPUT_DIR));

// --------------------------------------------------
// JOB STORAGE
// --------------------------------------------------

const jobs = new Map();

// --------------------------------------------------
// GENERAL HELPERS
// --------------------------------------------------

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getAIClient() {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not configured.");
  }

  return import("@google/genai").then(({ GoogleGenAI }) => {
    return new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY
    });
  });
}

function isTemporaryGeminiError(error) {
  const message = String(
    error?.message || error || ""
  ).toLowerCase();

  const status = Number(
    error?.statusCode ||
    error?.code ||
    error?.response?.status ||
    0
  );

  const statusText = String(
    error?.status || ""
  ).toLowerCase();

  return (
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    statusText === "unavailable" ||
    statusText === "resource_exhausted" ||
    message.includes("high demand") ||
    message.includes("overloaded") ||
    message.includes("temporarily unavailable") ||
    message.includes("resource exhausted") ||
    message.includes("service unavailable") ||
    message.includes("503") ||
    message.includes("429") ||
    message.includes("502") ||
    message.includes("504")
  );
}

function getErrorMessage(error) {
  if (typeof error?.message === "string") {
    return error.message;
  }

  return String(error || "Unknown server error.");
}

function outputUrl(req, fileName) {
  const host = req.get("host");

  return (
    `${req.protocol}://${host}/outputs/` +
    encodeURIComponent(fileName)
  );
}

function safeUnlink(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return Promise.resolve();
  }

  return fsp.unlink(filePath).catch(error => {
    console.error("FILE CLEANUP ERROR:", error.message);
  });
}

// --------------------------------------------------
// GEMINI MODEL FALLBACK
// --------------------------------------------------

async function generateRecapWithFallback(ai, contents) {
  const models = [
    ...new Set([
      GEMINI_MODEL,
      ...GEMINI_FALLBACK_MODELS
    ])
  ];

  let lastError = null;

  for (const model of models) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(
          `Gemini recap: ${model}, attempt ${attempt}/2`
        );

        const response = await ai.models.generateContent({
          model,
          contents
        });

        const recapText = response.text;

        if (
          !recapText ||
          !recapText.trim()
        ) {
          throw new Error(
            `Gemini ${model} returned an empty recap.`
          );
        }

        console.log(
          `Gemini recap succeeded using ${model}`
        );

        return {
          text: recapText.trim(),
          model
        };

      } catch (error) {
        lastError = error;

        console.error(
          `Gemini ${model} failed:`,
          getErrorMessage(error)
        );

        if (!isTemporaryGeminiError(error)) {
          throw error;
        }

        if (attempt < 2) {
          await sleep(3000 * attempt);
        }
      }
    }

    console.log(
      `${model} unavailable. Trying next model.`
    );
  }

  const finalError = new Error(
    "Gemini Models အားလုံး လက်ရှိအချိန်တွင် အလုပ်မလုပ်နိုင်သေးပါ။ ခဏစောင့်ပြီး ပြန်စမ်းပါ။"
  );

  finalError.status = 503;
  finalError.originalError = lastError;

  throw finalError;
}

// --------------------------------------------------
// VIDEO INFORMATION
// --------------------------------------------------

function getVideoInfo(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        return reject(err);
      }

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

      const duration = Number(
        metadata.format.duration || 0
      );

      const width = Number(
        videoStream.width || 0
      );

      const height = Number(
        videoStream.height || 0
      );

      resolve({
        duration,
        width,
        height,
        resolution: `${width}x${height}`,
        frameRate: videoStream.r_frame_rate || "unknown",
        videoCodec: videoStream.codec_name || "unknown",
        audioCodec: audioStream
          ? audioStream.codec_name
          : null,
        hasAudio: Boolean(audioStream),
        fileSize: Number(metadata.format.size || 0),
        format: metadata.format.format_name || "unknown"
      });
    });
  });
}

// --------------------------------------------------
// FFMPEG RUNNER
// --------------------------------------------------

function runFFmpeg(command) {
  return new Promise((resolve, reject) => {
    command
      .on("end", resolve)
      .on("error", reject)
      .run();
  });
}

// --------------------------------------------------
// TEXT SPLITTER
// --------------------------------------------------

function splitText(text, maxChars = 2500) {
  const normalized = String(text || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();

  if (!normalized) {
    return [];
  }

  const sentences = normalized.match(
    /[^။.!?]+[။.!?]?/g
  ) || [normalized];

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

      for (
        let i = 0;
        i < part.length;
        i += maxChars
      ) {
        chunks.push(
          part.slice(i, i + maxChars)
        );
      }

      continue;
    }

    const combined = current
      ? `${current} ${part}`
      : part;

    if (combined.length > maxChars) {
      if (current) {
        chunks.push(current);
      }

      current = part;
    } else {
      current = combined;
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

// --------------------------------------------------
// WAV HEADER GENERATOR
// --------------------------------------------------

function createWavBuffer(
  pcmBuffer,
  sampleRate = 24000,
  channels = 1,
  bitsPerSample = 16
) {
  const bytesPerSample = bitsPerSample / 8;

  const blockAlign =
    channels * bytesPerSample;

  const byteRate =
    sampleRate * blockAlign;

  const header = Buffer.alloc(44);

  header.write("RIFF", 0);
  header.writeUInt32LE(
    36 + pcmBuffer.length,
    4
  );

  header.write("WAVE", 8);
  header.write("fmt ", 12);

  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);

  header.writeUInt32LE(
    sampleRate,
    24
  );

  header.writeUInt32LE(
    byteRate,
    28
  );

  header.writeUInt16LE(
    blockAlign,
    32
  );

  header.writeUInt16LE(
    bitsPerSample,
    34
  );

  header.write("data", 36);

  header.writeUInt32LE(
    pcmBuffer.length,
    40
  );

  return Buffer.concat([
    header,
    pcmBuffer
  ]);
}

// --------------------------------------------------
// GEMINI TTS GENERATION
// --------------------------------------------------

async function generateSpeech(
  ai,
  text,
  outputPath
) {
  const response = await ai.models.generateContent({
    model: GEMINI_TTS_MODEL,

    contents: [
      {
        role: "user",
        parts: [
          {
            text:
              "Read the following Burmese narration naturally. " +
              "Use clear Burmese pronunciation, a warm storytelling " +
              "voice, and a moderate speaking pace.\n\n" +
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
            voiceName: GEMINI_TTS_VOICE
          }
        }
      }
    }
  });

  const audioPart =
    response.candidates?.[0]?.content?.parts?.find(
      part => part.inlineData?.data
    );

  if (!audioPart) {
    throw new Error(
      "Gemini TTS returned no audio data."
    );
  }

  const audioData =
    audioPart.inlineData.data;

  const mimeType =
    audioPart.inlineData.mimeType || "";

  const audioBuffer = Buffer.from(
    audioData,
    "base64"
  );

  if (!audioBuffer.length) {
    throw new Error(
      "Gemini returned empty audio data."
    );
  }

  // Keep an existing valid WAV file.
  if (
    mimeType.toLowerCase().includes("wav") ||
    audioBuffer.toString("ascii", 0, 4) === "RIFF"
  ) {
    await fsp.writeFile(
      outputPath,
      audioBuffer
    );

    return;
  }

  // Gemini PCM audio is commonly 16-bit little-endian.
  const rateMatch = mimeType.match(
    /rate=(\d+)/i
  );

  const sampleRate = rateMatch
    ? Number(rateMatch[1])
    : 24000;

  const wavBuffer = createWavBuffer(
    audioBuffer,
    sampleRate,
    1,
    16
  );

  await fsp.writeFile(
    outputPath,
    wavBuffer
  );

  console.log(
    "TTS audio saved:",
    mimeType,
    sampleRate,
    audioBuffer.length
  );
}

// --------------------------------------------------
// COMBINE AUDIO CHUNKS
// --------------------------------------------------

async function combineWavFiles(
  files,
  outputPath
) {
  if (!files.length) {
    throw new Error(
      "No audio files to combine."
    );
  }

  if (files.length === 1) {
    await runFFmpeg(
      ffmpeg()
        .input(files[0])
        .audioChannels(1)
        .audioFrequency(24000)
        .audioCodec("pcm_s16le")
        .format("wav")
        .output(outputPath)
    );

    return;
  }

  const command = ffmpeg();

  for (const file of files) {
    command.input(file);
  }

  const inputLabels = files
    .map((_, index) => `[${index}:a:0]`)
    .join("");

  const filter =
    `${inputLabels}` +
    `concat=n=${files.length}:v=0:a=1[out]`;

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
      .output(outputPath)
  );
}

// --------------------------------------------------
// MULTER VIDEO UPLOAD
// --------------------------------------------------

const allowedExtensions = [
  ".mp4",
  ".mov",
  ".mkv",
  ".webm",
  ".avi",
  ".m4v"
];

const storage = multer.diskStorage({
  destination(req, file, cb) {
    cb(null, UPLOAD_DIR);
  },

  filename(req, file, cb) {
    const id = crypto.randomUUID();

    const ext = path.extname(
      file.originalname
    ).toLowerCase();

    cb(null, `${id}${ext}`);
  }
});

const upload = multer({
  storage,

  limits: {
    fileSize: MAX_UPLOAD_SIZE,
    files: 1
  },

  fileFilter(req, file, cb) {
    const ext = path.extname(
      file.originalname
    ).toLowerCase();

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
    version: "4.0.0"
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    status: "OK",

    ffmpeg: Boolean(ffmpegPath),
    ffprobe: Boolean(ffprobePath),

    geminiConfigured: Boolean(
      process.env.GEMINI_API_KEY
    ),

    geminiModel: GEMINI_MODEL,
    geminiFallbackModels: GEMINI_FALLBACK_MODELS,

    ttsModel: GEMINI_TTS_MODEL,
    ttsVoice: GEMINI_TTS_VOICE,

    maxUploadSize: MAX_UPLOAD_SIZE,
    maxVideoDuration: MAX_VIDEO_DURATION,

    timestamp: new Date().toISOString()
  });
});

// --------------------------------------------------
// UPLOAD VIDEO
// --------------------------------------------------

app.post(
  "/api/upload",
  upload.single("video"),
  async (req, res) => {
    let uploadedFilePath = null;

    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: "Please select a video file."
        });
      }

      uploadedFilePath = req.file.path;

      const videoInfo = await getVideoInfo(
        uploadedFilePath
      );

      if (videoInfo.duration <= 0) {
        await safeUnlink(uploadedFilePath);

        return res.status(400).json({
          success: false,
          message: "Could not determine video duration."
        });
      }

      if (
        videoInfo.duration > MAX_VIDEO_DURATION
      ) {
        await safeUnlink(uploadedFilePath);

        return res.status(400).json({
          success: false,
          message:
            "Video duration exceeds the maximum allowed duration.",
          maxDuration: MAX_VIDEO_DURATION,
          actualDuration: videoInfo.duration
        });
      }

      const jobId = crypto.randomUUID();

      const job = {
        id: jobId,

        status: "ready",
        progress: 5,
        stage: "Video ready",

        originalName: req.file.originalname,
        filePath: uploadedFilePath,
        fileSize: req.file.size,

        createdAt: new Date().toISOString(),

        videoInfo,

        recapScript: null,
        recapModel: null,
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
      console.error(
        "UPLOAD ERROR:",
        error
      );

      await safeUnlink(uploadedFilePath);

      return res.status(500).json({
        success: false,
        message: getErrorMessage(error)
      });
    }
  }
);

// --------------------------------------------------
// GEMINI RECAP
// --------------------------------------------------

app.post(
  "/api/jobs/:id/recap",
  async (req, res) => {
    const job = jobs.get(req.params.id);

    if (!job) {
      return res.status(404).json({
        success: false,
        message: "Job not found."
      });
    }

    if (
      !job.filePath ||
      !fs.existsSync(job.filePath)
    ) {
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

      const ext = path.extname(
        job.filePath
      ).toLowerCase();

      const mimeTypes = {
        ".mp4": "video/mp4",
        ".mov": "video/quicktime",
        ".mkv": "video/x-matroska",
        ".webm": "video/webm",
        ".avi": "video/x-msvideo",
        ".m4v": "video/mp4"
      };

      const mimeType =
        mimeTypes[ext] || "video/mp4";

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

      while (
        geminiFile.state === "PROCESSING"
      ) {
        if (
          Date.now() - startedAt > timeout
        ) {
          throw new Error(
            "Gemini video processing timed out."
          );
        }

        await sleep(3000);

        geminiFile = await ai.files.get({
          name: geminiFile.name
        });
      }

      if (geminiFile.state === "FAILED") {
        throw new Error(
          "Gemini could not process the video."
        );
      }

      if (geminiFile.state !== "ACTIVE") {
        throw new Error(
          `Unexpected Gemini file state: ${geminiFile.state}`
        );
      }

      job.progress = 45;
      job.stage = "AI is analyzing the story";

      const recapPrompt = `
You are an expert movie recap storyteller.

Analyze the actual uploaded video and write a detailed,
natural Burmese-language movie recap script.

IMPORTANT RULES:

1. Write naturally and fluently in Burmese.
2. Explain the story in chronological order.
3. Include important characters and motivations.
4. Include conflicts and turning points.
5. Include meaningful conversations and their meaning.
6. Explain important scenes in detail.
7. Explain the ending if it is visible.
8. Do not invent scenes, names, dialogue, or events.
9. Do not guess unclear details.
10. Preserve important story details.
11. Do not make the recap extremely short.
12. Use engaging narration suitable for a movie recap.
13. Do not add unrelated opinions or false claims.
14. Start with an engaging hook.
15. Return only the Burmese recap script.
16. Maintain the original story sequence.
17. Include important character interactions.
18. Do not skip important plot developments.

Analyze the actual uploaded video.
Do not create a story based on assumptions.
Preserve important story details.
`;

      const contents = [
        {
          role: "user",

          parts: [
            {
              fileData: {
                fileUri: geminiFile.uri,
                mimeType:
                  geminiFile.mimeType || mimeType
              }
            },

            {
              text: recapPrompt
            }
          ]
        }
      ];

      const result =
        await generateRecapWithFallback(
          ai,
          contents
        );

      job.recapScript = result.text;
      job.recapModel = result.model;

      job.recapStatus = "completed";
      job.status = "ready";
      job.progress = 50;
      job.stage = "Burmese recap script generated";
      job.error = null;

      return res.json({
        success: true,

        message:
          "Burmese recap script generated successfully.",

        usedModel: result.model,

        job: {
          id: job.id,
          status: job.status,
          progress: job.progress,
          stage: job.stage,

          recapStatus: job.recapStatus,
          recapScript: job.recapScript,
          recapModel: job.recapModel
        }
      });

    } catch (error) {
      console.error(
        "GEMINI RECAP ERROR:",
        error
      );

      const temporaryError =
        isTemporaryGeminiError(error) ||
        Number(error.status) === 503;

      job.recapStatus = "failed";
      job.status = "error";
      job.error = getErrorMessage(error);
      job.stage = "AI recap failed";

      return res.status(
        temporaryError ? 503 : 500
      ).json({
        success: false,
        message: job.error,

        errorType: temporaryError
          ? "GEMINI_TEMPORARILY_UNAVAILABLE"
          : "GEMINI_RECAP_FAILED"
      });
    }
  }
);

// --------------------------------------------------
// GENERATE BURMESE VOICE
// --------------------------------------------------

app.post(
  "/api/jobs/:id/voice",
  async (req, res) => {
    const job = jobs.get(req.params.id);

    if (!job) {
      return res.status(404).json({
        success: false,
        message: "Job not found."
      });
    }

    const text = String(
      req.body?.text ||
      job.recapScript ||
      ""
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
        message:
          "Voice generation is already processing."
      });
    }

    try {
      const ai = await getAIClient();

      job.voiceStatus = "processing";
      job.progress = 55;
      job.stage = "Generating Burmese AI voice";
      job.error = null;

      const chunks = splitText(text, 2500);

      if (!chunks.length) {
        throw new Error(
          "No usable text was found."
        );
      }

      const chunkFiles = [];

      try {
        for (
          let i = 0;
          i < chunks.length;
          i++
        ) {
          const chunkPath = path.join(
            TEMP_DIR,
            `${job.id}-voice-${i}.wav`
          );

          await generateSpeech(
            ai,
            chunks[i],
            chunkPath
          );

          chunkFiles.push(chunkPath);

          job.progress = 55 + Math.round(
            ((i + 1) / chunks.length) * 25
          );

          job.stage =
            `Generating voice ${i + 1}/${chunks.length}`;
        }

        const voiceFileName =
          `${job.id}-voice.wav`;

        const voicePath = path.join(
          OUTPUT_DIR,
          voiceFileName
        );

        await combineWavFiles(
          chunkFiles,
          voicePath
        );

        // Validate generated audio.
        const audioInfo = await new Promise(
          (resolve, reject) => {
            ffmpeg.ffprobe(
              voicePath,
              (error, metadata) => {
                if (error) {
                  return reject(error);
                }

                const audioStream =
                  metadata.streams.find(
                    stream =>
                      stream.codec_type === "audio"
                  );

                if (!audioStream) {
                  return reject(
                    new Error(
                      "Generated file has no audio stream."
                    )
                  );
                }

                resolve({
                  duration: Number(
                    metadata.format.duration || 0
                  ),
                  codec: audioStream.codec_name
                });
              }
            );
          }
        );

        if (audioInfo.duration <= 0) {
          throw new Error(
            "Generated audio duration is invalid."
          );
        }

        job.voiceFile = voicePath;
        job.voiceUrl = outputUrl(
          req,
          voiceFileName
        );

        job.voiceStatus = "completed";
        job.progress = 80;
        job.stage = "Burmese voice generated";
        job.error = null;

        return res.json({
          success: true,

          message:
            "Burmese AI voice generated successfully.",

          job: {
            id: job.id,
            voiceStatus: job.voiceStatus,
            voiceUrl: job.voiceUrl,
            progress: job.progress,
            stage: job.stage,
            audioInfo
          }
        });

      } finally {
        for (const file of chunkFiles) {
          await safeUnlink(file);
        }
      }

    } catch (error) {
      console.error(
        "VOICE GENERATION ERROR:",
        error
      );

      job.voiceStatus = "failed";
      job.error = getErrorMessage(error);
      job.stage = "Voice generation failed";

      return res.status(500).json({
        success: false,
        message: job.error
      });
    }
  }
);

// --------------------------------------------------
// RENDER MP4 WITH BURMESE VOICE
// --------------------------------------------------

app.post(
  "/api/jobs/:id/render",
  async (req, res) => {
    const job = jobs.get(req.params.id);

    if (!job) {
      return res.status(404).json({
        success: false,
        message: "Job not found."
      });
    }

    if (
      !job.filePath ||
      !fs.existsSync(job.filePath)
    ) {
      return res.status(404).json({
        success: false,
        message: "Original video file is missing."
      });
    }

    if (
      !job.voiceFile ||
      !fs.existsSync(job.voiceFile)
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Generate the Burmese voice before rendering."
      });
    }

    if (job.renderStatus === "processing") {
      return res.status(409).json({
        success: false,
        message:
          "Video rendering is already processing."
      });
    }

    try {
      job.renderStatus = "processing";
      job.status = "rendering";
      job.progress = 82;
      job.stage =
        "Combining original video and Burmese voice";
      job.error = null;

      const outputFileName =
        `${job.id}-recap.mp4`;

      const outputPath = path.join(
        OUTPUT_DIR,
        outputFileName
      );

      // Keep the full original video duration.
      // Replace the original audio with Burmese narration.
      // If narration is shorter, pad with silence.
      const duration = Number(
        job.videoInfo?.duration || 0
      );

      const command = ffmpeg()
        .input(job.filePath)
        .input(job.voiceFile)
        .outputOptions([
          "-map 0:v:0",
          "-map 1:a:0",
          "-c:v copy",
          "-c:a aac",
          "-b:a 192k",
          "-af apad",
          "-movflags +faststart"
        ]);

      if (duration > 0) {
        command.outputOptions([
          "-t",
          String(duration)
        ]);
      }

      await runFFmpeg(
        command.output(outputPath)
      );

      // Verify output file.
      if (
        !fs.existsSync(outputPath) ||
        fs.statSync(outputPath).size === 0
      ) {
        throw new Error(
          "Rendered MP4 file is empty or missing."
        );
      }

      job.outputFile = outputPath;
      job.outputUrl = outputUrl(
        req,
        outputFileName
      );

      job.renderStatus = "completed";
      job.status = "ready";
      job.progress = 100;
      job.stage = "MP4 render completed";
      job.error = null;

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
      console.error(
        "RENDER ERROR:",
        error
      );

      job.renderStatus = "failed";
      job.status = "error";
      job.error = getErrorMessage(error);
      job.stage = "Video rendering failed";

      return res.status(500).json({
        success: false,
        message: job.error
      });
    }
  }
);

// --------------------------------------------------
// GET JOB STATUS
// --------------------------------------------------

app.get(
  "/api/jobs/:id",
  (req, res) => {
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
        recapModel: job.recapModel,

        voiceStatus: job.voiceStatus,
        voiceUrl: job.voiceUrl,

        renderStatus: job.renderStatus,
        outputUrl: job.outputUrl,

        error: job.error
      }
    });
  }
);

// --------------------------------------------------
// DELETE JOB
// --------------------------------------------------

app.delete(
  "/api/jobs/:id",
  async (req, res) => {
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
        await safeUnlink(file);
      }

      jobs.delete(req.params.id);

      return res.json({
        success: true,
        message: "Job deleted successfully."
      });

    } catch (error) {
      console.error(
        "DELETE ERROR:",
        error
      );

      return res.status(500).json({
        success: false,
        message: "Could not delete job."
      });
    }
  }
);

// --------------------------------------------------
// GLOBAL ERROR HANDLER
// --------------------------------------------------

app.use((err, req, res, next) => {
  console.error(
    "SERVER ERROR:",
    err
  );

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
    message: getErrorMessage(err)
  });
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

app.listen(PORT, "0.0.0.0", () => {
  console.log("--------------------------------------");
  console.log("HWA Burmese Auto Recap Backend");
  console.log("Version: 4.0.0");
  console.log(`Port: ${PORT}`);

  console.log(
    `Upload Directory: ${UPLOAD_DIR}`
  );

  console.log(
    `Output Directory: ${OUTPUT_DIR}`
  );

  console.log(
    `Gemini Recap Model: ${GEMINI_MODEL}`
  );

  console.log(
    `Gemini Fallback Models: ${GEMINI_FALLBACK_MODELS.join(", ")}`
  );

  console.log(
    `Gemini TTS Model: ${GEMINI_TTS_MODEL}`
  );

  console.log(
    `Gemini TTS Voice: ${GEMINI_TTS_VOICE}`
  );

  console.log("--------------------------------------");
});
