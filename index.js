const path = require('path');
const fs = require('fs');
require('dotenv').config();

const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
ffmpeg.setFfmpegPath(ffmpegPath);

const { GoogleGenerativeAI } = require('@google/generative-ai');

const GEMINI_MODEL = 'gemini-2.5-flash-lite';

exports.receiveNote = (req, res) => {

  if (!req.file) {
    return res.status(400).json({ error: 'No audio uploaded' });
  }

  res.status(200).json({ message: 'File received' });

  (async () => {
    try {
      await transcribeAndSave(
        req.file.path,
        req.file.originalname,
        req.file.mimetype
      );
    } catch (err) {
      console.error("Async error:", err);
    }
  })();

};

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function formatDateFolder(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

async function convertToPCMwav(inputPath) {

  const outputPath =
    inputPath.replace(path.extname(inputPath), "") +
    "_pcm.wav";

  return new Promise((resolve, reject) => {

    ffmpeg(inputPath)
      .audioFrequency(16000)
      .audioChannels(1)
      .audioCodec("pcm_s16le")
      .format("wav")

      .on("error", err => reject(err))

      .on("end", () => {
        console.log("Converted → PCM WAV");
        resolve(outputPath);
      })

      .save(outputPath);

  });
}

async function transcribeAndSave(originalFilePath, originalName, mimeTypeArg) {

  const outBase = path.join(process.cwd(), 'notes_text_transcribe');
  const outDir = path.join(outBase, formatDateFolder());
  ensureDir(outDir);

  const googleKey = process.env.GEMINI_API_KEY;
  if (!googleKey) return console.error("Gemini key missing");

  let processingPath = originalFilePath;
  let finalMimeType = mimeTypeArg;

  const ext = path.extname(originalFilePath).toLowerCase();

  const supported = [
    ".wav",
    ".mp3",
    ".flac",
    ".ogg",
    ".aac",
    ".aiff"
  ];

  if (!supported.includes(ext)) {

    console.log("Unsupported:", ext);
    console.log("Converting...");

    processingPath = await convertToPCMwav(originalFilePath);
    finalMimeType = "audio/wav";

  }

  let result = null;

  try {

    result = await transcribeWithGemini(
      processingPath,
      googleKey,
      finalMimeType
    );

  } catch (e) {

    console.error("Gemini error:", e.message);

  }

  if (!result?.text) return;

  const baseName = path.basename(originalName, path.extname(originalName));

  const txtPath = path.join(outDir, `${baseName}.txt`);
  const metaPath = path.join(outDir, `${baseName}.json`);

  fs.writeFileSync(txtPath, result.text, "utf8");

  fs.writeFileSync(metaPath, JSON.stringify({
    source: originalName,
    createdAt: new Date().toISOString(),
    provider: "gemini",
    timeMs: result.timeMs,
    tokens: result.tokens,
    model: GEMINI_MODEL
  }, null, 2));

  console.log("Saved:", txtPath);

  try {

    if (processingPath !== originalFilePath) {
      fs.unlinkSync(processingPath);
      console.log("Temp WAV deleted");
    }

    fs.unlinkSync(originalFilePath);
    console.log("Original deleted");

  } catch(e) {}

}

async function transcribeWithGemini(filePath, apiKey, mimeType) {

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });

  const fileBuffer = await fs.promises.readFile(filePath);
  const b64 = fileBuffer.toString("base64");

  const start = Date.now();

  const result = await model.generateContent({

    contents: [{
      role: "user",
      parts: [
        {
          text: `
Transcribe this audio and generate:

Summary:
...

Action Items:
- ...

Key Points:
- ...
`
        },
        {
          inlineData: {
            mimeType,
            data: b64
          }
        }
      ]
    }],

    generationConfig: {
      temperature: 0.2,
      topK: 40,
      topP: 0.8,
      maxOutputTokens: 2048
    }

  });

  const end = Date.now();

  return {
    text: result.response.text(),
    tokens: result?.usageMetadata || null,
    timeMs: end - start
  };

}
