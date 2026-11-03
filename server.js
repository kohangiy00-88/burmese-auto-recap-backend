
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const ffprobePath = require("ffprobe-static").path;

const app = express();

const PORT = process.env.PORT || 10000;

const MAX_UPLOAD_SIZE =
  Number(process.env.MAX_UPLOAD_SIZE) ||
  1024 * 1024 * 1024; // 1 GB

const MAX_VIDEO_DURATION =
  Number(process.env.MAX_VIDEO_DURATION) ||
  350 * 60; // 350 minutes

const GEMINI_MODEL =
  process.env.GEMINI_MODEL || "gemini-2.5-flash";

const UPLOAD_DIR = path.join(__dirname, "uploads");
const OUTPUT_DIR = path.join(__dirname, "outputs");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

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

// --------------------------------------------------
// JOB STORAGE
// --------------------------------------------------

const jobs = new Map();

// --------------------------------------------------
// MULTER UPLOAD
// --------------------------------------------------

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOAD_DIR);
  },

  filename: function (req, file, cb) {
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

  fileFilter: function (req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();

    if (!allowedExtensions.includes(ext)) {
      return cb(
        new Error(
          "Unsupported video format. Please upload MP4, MOV, MKV, WEBM, AVI or M4V."
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
    version: "1.1.0"
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
    timestamp: new Date().toISOString()
  });
});

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
          new Error(
            "The uploaded file does not contain a video stream."
          )
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

      const jobId = crypto.randomUUID();

      const job = {
        id: jobId,
        status: "uploaded",
        progress: 0,
        stage: "Video uploaded",
        originalName: req.file.originalname,
        filePath: uploadedFilePath,
        fileSize: req.file.size,
        createdAt: new Date().toISOString(),

        videoInfo: null,

        recapScript: null,
        recapStatus: "not_started",

        error: null
      };

      jobs.set(jobId, job);

      job.status = "analyzing";
      job.stage = "Analyzing video information";

      const videoInfo = await getVideoInfo(uploadedFilePath);

      if (videoInfo.duration > MAX_VIDEO_DURATION) {
        if (fs.existsSync(uploadedFilePath)) {
          fs.unlinkSync(uploadedFilePath);
        }

        jobs.delete(jobId);

        return res.status(400).json({
          success: false,
          message:
            "Video duration exceeds the maximum allowed duration.",
          maxDuration: MAX_VIDEO_DURATION,
          actualDuration: videoInfo.duration
        });
      }

      job.videoInfo = videoInfo;
      job.status = "ready";
      job.progress = 5;
      job.stage = "Video ready for AI recap";

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

      if (
        uploadedFilePath &&
        fs.existsSync(uploadedFilePath)
      ) {
        try {
          fs.unlinkSync(uploadedFilePath);
        } catch (cleanupError) {
          console.error("UPLOAD CLEANUP ERROR:", cleanupError);
        }
      }

      return res.status(500).json({
        success: false,
        message: error.message || "Video upload failed."
      });
    }
  }
);

// --------------------------------------------------
// GEMINI AI RECAP
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

  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({
      success: false,
      message:
        "GEMINI_API_KEY is not configured on the server."
    });
  }

  try {
    job.status = "recapping";
    job.recapStatus = "processing";
    job.progress = 10;
    job.stage = "Uploading video to Gemini AI";
    job.error = null;

    // Import Gemini SDK for this request.
    const { GoogleGenAI } = await import("@google/genai");

    const ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY
    });

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

    // Upload video to Gemini Files API.
    let geminiFile = await ai.files.upload({
      file: job.filePath,

      config: {
        mimeType,
        displayName: job.originalName
      }
    });

    job.progress = 25;
    job.stage = "Gemini is preparing the video";

    // Wait for Gemini file processing.
    const processingStartedAt = Date.now();

    const processingTimeout = 10 * 60 * 1000;

    while (geminiFile.state === "PROCESSING") {
      if (
        Date.now() - processingStartedAt >
        processingTimeout
      ) {
        throw new Error(
          "Gemini video processing timed out."
        );
      }

      await new Promise(resolve =>
        setTimeout(resolve, 3000)
      );

      geminiFile = await ai.files.get({
        name: geminiFile.name
      });
    }

    if (geminiFile.state === "FAILED") {
      throw new Error(
        "Gemini could not process the uploaded video."
      );
    }

    job.progress = 45;
    job.stage = "AI is analyzing the story";

    const recapPrompt = `
You are an expert movie recap storyteller.

Analyze the uploaded video and write a detailed,
natural Burmese-language movie recap script.

IMPORTANT RULES:

1. Write naturally and fluently in Burmese.
2. Explain the story in chronological order.
3. Include important characters and their motivations.
4. Include important conflicts and turning points.
5. Include meaningful conversations by paraphrasing them.
6. Explain the ending when it is visible in the video.
7. Do not invent scenes, dialogue, character names, or events.
8. If a detail is unclear, do not guess.
9. Preserve important story details.
10. Do not make the recap extremely short.
11. Use engaging narration suitable for a YouTube movie recap.
12. Do not include subtitles or timestamps unless necessary.
13. Do not copy long dialogue word-for-word.
14. Use your own narration and wording.
15. Start with an engaging hook.
16. Then explain the story clearly from beginning to end.
17. Do not add unrelated opinions or false claims.

Return only the Burmese recap script.
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
                mimeType:
                  geminiFile.mimeType || mimeType
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

    if (
      !recapText ||
      !recapText.trim()
    ) {
      throw new Error(
        "Gemini returned an empty recap script."
      );
    }

    job.recapScript = recapText.trim();
    job.recapStatus = "completed";
    job.status = "ready";
    job.progress = 50;
    job.stage = "Burmese recap script generated";

    return res.json({
      success: true,

      message:
        "Burmese recap script generated successfully.",

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
    job.error =
      error.message || "AI recap failed.";

    job.stage = "AI recap failed";

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

      error: job.error
    }
  });
});

// --------------------------------------------------
// DELETE JOB
// --------------------------------------------------

app.delete("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({
      success: false,
      message: "Job not found."
    });
  }

  try {
    if (
      job.filePath &&
      fs.existsSync(job.filePath)
    ) {
      fs.unlinkSync(job.filePath);
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
    message:
      err.message || "Request failed."
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
  console.log(`Gemini Model: ${GEMINI_MODEL}`);
  console.log("--------------------------------------");
});
