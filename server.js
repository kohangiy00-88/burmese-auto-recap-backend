
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
    version: "1.0.0"
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    status: "OK",
    ffmpeg: Boolean(ffmpegPath),
    ffprobe: Boolean(ffprobePath),
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
          new Error("The uploaded file does not contain a video stream.")
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
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: "Please select a video file."
        });
      }

      const jobId = crypto.randomUUID();

      const filePath = req.file.path;

      const job = {
        id: jobId,
        status: "uploaded",
        progress: 0,
        stage: "Video uploaded",
        originalName: req.file.originalname,
        filePath,
        fileSize: req.file.size,
        createdAt: new Date().toISOString(),
        videoInfo: null,
        error: null
      };

      jobs.set(jobId, job);

      // Analyze the uploaded video.
      job.status = "analyzing";
      job.stage = "Analyzing video information";

      const videoInfo = await getVideoInfo(filePath);

      if (videoInfo.duration > MAX_VIDEO_DURATION) {
        fs.unlinkSync(filePath);

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
          videoInfo: job.videoInfo
        }
      });
    } catch (error) {
      console.error("UPLOAD ERROR:", error);

      return res.status(500).json({
        success: false,
        message: error.message || "Video upload failed."
      });
    }
  }
);

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

  res.json({
    success: true,
    job: {
      id: job.id,
      status: job.status,
      progress: job.progress,
      stage: job.stage,
      originalName: job.originalName,
      fileSize: job.fileSize,
      videoInfo: job.videoInfo,
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
    if (job.filePath && fs.existsSync(job.filePath)) {
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

  return res.status(500).json({
    success: false,
    message: err.message || "Internal server error."
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
  console.log("--------------------------------------");
});
