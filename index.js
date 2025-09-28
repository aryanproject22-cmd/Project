// index.js - Single-file Notes Maker Server (Gemini version)

require("dotenv").config(); // Load environment variables from .env file
const express = require("express");
const multer = require("multer");
const mongoose = require("mongoose");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { saveNotes, getAllNotes, getNoteById, deleteNote } = require("./controllers/noteController");

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY;

// Database connection function
const connectDB = async () => {
    try {
        const mongoUri = process.env.MONGO_URI;
        if (!mongoUri) {
            throw new Error('MONGO_URI environment variable is not set. Please check your .env file.');
        }
        await mongoose.connect(mongoUri);
        console.log('✅ MongoDB Connected Successfully');
    } catch (error) {
        console.error('❌ MongoDB Connection Error:', error.message);
        process.exit(1); // Exit process on failure
    }
};

// Using Gemini 2.5 Flash Lite model
const GEMINI_MODEL = "gemini-2.5-flash-lite";

// System instruction for structured academic notes
const SYSTEM_INSTRUCTION = `You are an expert academic tutor and professional note-maker. Your task is to take brief, simple, or incomplete notes and transform them into a comprehensive, well-structured, and easy-to-read study guide suitable for a university student. 
The output MUST include:
1. A clear, concise Title.
2. An Introduction (1-2 sentences).
3. The main content organized with bolded Level 2 Headings (## Heading), bullet points, and numbered lists where appropriate.
4. Key Definitions highlighted at the end.
Do not include any preamble, just start with the Title.`;

if (!API_KEY) {
  console.error("FATAL: GEMINI_API_KEY not found in .env file.");
  console.error("Please create a .env file with your GEMINI_API_KEY and MONGO_URI.");
  process.exit(1);
}

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(API_KEY);
const model = genAI.getGenerativeModel({ 
  model: GEMINI_MODEL,
  systemInstruction: SYSTEM_INSTRUCTION
});

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    // Accept audio files and any other files
    if (file.mimetype.startsWith('audio/') || file.mimetype.startsWith('text/') || file.fieldname === 'content') {
      cb(null, true);
    } else {
      cb(new Error('Only audio and text files are allowed!'), false);
    }
  }
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.text());

// --- Health Check Endpoint ---
app.get("/api/health", (req, res) => {
  res.status(200).json({ status: "healthy", timestamp: new Date().toISOString() });
});

// --- Optional Root Route ---
app.get("/", (req, res) => {
  res.send("Welcome to the AI Notes Maker Server (Gemini Powered) latest");
});

// --- Notes Generation Endpoint ---
app.post("/generate-notes", upload.fields([
  { name: 'type', maxCount: 1 },
  { name: 'content', maxCount: 1 }
]), async (req, res) => {
  console.log("Request body:", req.body);
  console.log("Request files:", req.files);
  console.log("Request headers:", req.headers);
  
  const type = req.body.type;
  let content = req.body.content;

  // If content is uploaded as a file, read it
  if (req.files && req.files.content && req.files.content[0]) {
    const file = req.files.content[0];
    console.log("File uploaded:", file.originalname, file.mimetype, file.size);
    
    if (file.mimetype.startsWith('audio/')) {
      // For audio files, we'll process the actual file
      content = file; // Store the file object for processing
      console.log("Audio file received for processing:", file.originalname, file.mimetype, file.size);
    } else if (file.mimetype.startsWith('text/')) {
      // For text files, read the content
      content = file.buffer.toString('utf8');
      console.log("Text file content read");
    }
  }

  if (!type || !content) {
    return res.status(400).json({ 
      error: 'Missing "type" or "content" in the form data.',
      received_body: req.body,
      received_files: req.files,
      received_headers: req.headers
    });
  }

  try {
    let userPrompt = "";
    let audioFile = null;

    if (type === "text") {
      console.log("Processing text notes...");
      userPrompt = `Elaborate and organize the following professor's notes: "${content}"`;

    } else if (type === "audio") {
      console.log("Processing audio file...");
      if (typeof content === 'object' && content.buffer) {
        // Audio file was uploaded
        audioFile = content;
        userPrompt = `Please transcribe this audio file and then generate comprehensive academic notes from the transcript. The audio file is: ${content.originalname} (${content.mimetype})`;
      } else {
        // Text content provided for audio type
        userPrompt = `Generate comprehensive academic notes from the following audio transcript: "${content}"`;
      }

    } else {
      return res.status(400).json({ error: 'Invalid input type. Must be "text" or "audio".' });
    }

    // Generate content using Gemini
    let result;
    
    if (audioFile) {
      // Include audio file in the request
      result = await model.generateContent({
        contents: [{ 
          role: "user", 
          parts: [
            { text: userPrompt },
            {
              inlineData: {
                mimeType: audioFile.mimetype,
                data: audioFile.buffer.toString('base64')
              }
            }
          ]
        }],
        generationConfig: {
          temperature: 0.2,
          topK: 40,
          topP: 0.8,
          maxOutputTokens: 2048,
        },
      });
    } else {
      // Text-only request
      result = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: userPrompt }] }],
        generationConfig: {
          temperature: 0.2,
          topK: 40,
          topP: 0.8,
          maxOutputTokens: 2048,
        },
      });
    }

    const generatedNotes = result.response.text();

    // Prepare data for saving to database
    const noteData = {
      input_type: type,
      generated_notes: generatedNotes
    };

    // Save notes to database
    try {
      const savedNote = await saveNotes(noteData);
      
      res.json({
        status: "success",
        input_type: type,
        model_used: GEMINI_MODEL,
        generated_notes: generatedNotes,
        note_id: savedNote._id,
        saved_at: savedNote.createdAt
      });
    } catch (dbError) {
      console.error("Database save error:", dbError);
      // Still return the generated notes even if database save fails
      res.json({
        status: "success",
        input_type: type,
        model_used: GEMINI_MODEL,
        generated_notes: generatedNotes,
        note_id: null,
        save_error: "Notes generated but failed to save to database"
      });
    }
  } catch (error) {
    console.error("Gemini API Error:", error);
    res.status(500).json({
      error: "Failed to generate notes from AI.",
      details: error.message,
    });
  }
});

// --- Notes Management Endpoints ---

// Get all notes
app.get("/api/notes", getAllNotes);

// Get a specific note by ID
app.get("/api/notes/:id", getNoteById);

// Delete a note by ID
app.delete("/api/notes/:id", deleteNote);

// --- Start Server ---
const startServer = async () => {
  try {
    // Connect to database first
    await connectDB();
    
    // Start the server
    app.listen(PORT, () => {
      console.log(`\n✅ AI Notes Maker Server running at http://localhost:${PORT}`);
      console.log(`Model in use: ${GEMINI_MODEL}`);
      console.log(`\nReady to receive POST requests at /generate-notes`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error.message);
    process.exit(1);
  }
};

// Start the application
startServer();