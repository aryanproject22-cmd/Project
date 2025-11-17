// index.js - Single-file Notes Maker Server (Gemini version)

require("dotenv").config(); // Load environment variables from .env file
const express = require("express");
const multer = require("multer");
const mongoose = require("mongoose");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { saveNotes } = require("./controllers/noteController");
const notesRoutes = require("./routes/notes");
const SYSTEM_INSTRUCTION = require("./config/systemInstruction");

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY;

// Global variable to track database connection status
let isDatabaseConnected = false;

// Database connection function
const connectDB = async () => {
    try {
        const mongoUri = process.env.MONGO_URI;
        if (!mongoUri) {
            console.warn('⚠️ MONGO_URI environment variable is not set. Database features will be disabled.');
            return false;
        }
        
        // Check if already connected
        if (mongoose.connection.readyState === 1) {
            console.log('✅ MongoDB Already Connected');
            return true;
        }
        
        // For serverless environments, use connection pooling
        await mongoose.connect(mongoUri, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
            maxPoolSize: 10,
            serverSelectionTimeoutMS: 5000,
            socketTimeoutMS: 45000,
            bufferCommands: false
        });
        
        console.log('✅ MongoDB Connected Successfully');
        return true;
    } catch (error) {
        console.error('❌ MongoDB Connection Error:', error.message);
        console.warn('⚠️ Continuing without database connection...');
        return false;
    }
};

// Ensure database connection for each request
const ensureDBConnection = async () => {
    if (!isDatabaseConnected) {
        console.log('🔄 Attempting to connect to database...');
        isDatabaseConnected = await connectDB();
    }
    return isDatabaseConnected;
};

// Using Gemini 2.5 Flash Lite model
const GEMINI_MODEL = "gemini-2.5-flash-lite";

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

// CORS middleware to allow all origins
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
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

// --- Database Status Endpoint ---
app.get("/api/db-status", async (req, res) => {
  const dbConnected = await ensureDBConnection();
  res.status(200).json({ 
    database_connected: dbConnected,
    mongoose_state: mongoose.connection.readyState,
    mongo_uri_set: !!process.env.MONGO_URI,
    timestamp: new Date().toISOString()
  });
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
    let detectedLanguage = "unknown";
    let detectedSubject = "General";

    // Function to detect language from text content
    const detectLanguage = async (text) => {
      try {
        const detectionResult = await model.generateContent({
          contents: [{ 
            role: "user", 
            parts: [{ 
              text: `Identify the language of this text. Respond with ONLY the language name in English (e.g., "English", "Spanish", "French", "Hindi", "Kannada", "Tamil", "Telugu", "Bengali", "Gujarati", "Marathi", "Punjabi", "Chinese", "Japanese", "Korean", "Arabic", "German", "Italian", "Portuguese", "Russian", etc.). Do not include any other text or explanation:

"${text.substring(0, 500)}"` 
            }] 
          }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 20,
          },
        });
        const detectedLang = detectionResult.response.text().trim();
        // Clean up any extra text that might come with the response
        const cleanLang = detectedLang.split('\n')[0].split('.')[0].trim();
        console.log("Raw language detection:", detectedLang);
        console.log("Cleaned language:", cleanLang);
        return cleanLang;
      } catch (error) {
        console.warn("Language detection failed:", error.message);
        return "unknown";
      }
    };

    // Function to detect subject from text content (improved: normalization + heuristic fallback)
    const detectSubject = async (text) => {
      const allowedSubjects = [
        "Mathematics","Physics","Chemistry","Biology","Programming",
        "Computer Science","History","Geography","Literature","Language",
        "Art","Music","Sports","Entertainment","General"
      ];

      const synonyms = {
        "computer science": "Computer Science",
        "cs": "Computer Science",
        "coding": "Programming",
        "programming": "Programming",
        "program": "Programming",
        "math": "Mathematics",
        "mathematics": "Mathematics",
        "physics": "Physics",
        "chemistry": "Chemistry",
        "biology": "Biology",
        "history": "History",
        "geography": "Geography",
        "literature": "Literature",
        "language": "Language",
        "linguistics": "Language",
        "art": "Art",
        "music": "Music",
        "sports": "Sports",
        "entertainment": "Entertainment",
        "general": "General"
      };

      const keywordMap = {
        "Mathematics": [
          "integral","derivative","algebra","calculus","theorem","matrix","probability","geometry","trigonometry",
          "statistics","differential equations","vector","tensor","limit","set theory","number theory","topology",
          "combinatorics","prime","logarithm","exponential","polynomial","inequality","function","graph theory",
          "optimization","linear algebra","stochastic","random variable","bayesian","euclidean","non-euclidean",
          "metric","proof","axiom","lemma","corollary","sequence","series","p-adic","symmetry","group theory",
          "ring","field","manifold","integrable","partial derivative","gradient","divergence","curl"
        ],
      
        "Physics": [
          "velocity","force","quantum","relativity","particle","energy","momentum","thermodynamics","optics",
          "mass","acceleration","friction","gravity","electromagnetism","wave","frequency","amplitude","spin",
          "string theory","boson","fermion","neutrino","photon","entropy","enthalpy","pressure","fluid dynamics",
          "nuclear","atomic","collision","radiation","magnetism","capacitance","resistance","superconductivity",
          "black hole","cosmology","astrophysics","inertia","scalar","vector","field","higgs","dark matter",
          "dark energy","interference","diffraction","relativistic"
        ],
      
        "Chemistry": [
          "molecule","reaction","chemical","atom","bond","ph","acid","oxidation","synthesis",
          "catalyst","organic","inorganic","covalent","ionic","solution","solvent","solute","concentration",
          "stoichiometry","thermochemistry","enthalpy","electrons","orbitals","periodic table","isotope",
          "polymer","crystal","precipitate","titration","spectroscopy","chromatography","equilibrium",
          "buffer","alkaline","halogen","transition metal","electrochemistry","redox","molarity","kinetics",
          "enthalpy","hydrocarbon","ester","amine"
        ],
      
        "Biology": [
          "cell","organism","evolution","dna","protein","genome","photosynthesis","mitosis",
          "meiosis","enzyme","chromosome","ribosome","mutation","gene","genetics","epigenetics",
          "ecosystem","bacteria","virus","fungi","microbe","adaptation","natural selection","anatomy",
          "physiology","immune system","respiration","metabolism","hormone","organ","species","taxonomy",
          "reproduction","biosphere","ecology","biome","cloning","biotechnology","neuron","synapse",
          "membrane","cytoplasm","mitochondria","chloroplast"
        ],
      
        "Programming": [
          "function","variable","loop","algorithm","code","compile","runtime","bug","debug",
          "class","object","inheritance","polymorphism","interface","recursion","pointer","array","list",
          "dictionary","hashmap","framework","library","module","package","thread","concurrency","parallel",
          "asynchronous","promise","exception","error","syntax","interpreter","compiler","optimization",
          "API","REST","JSON","XML","version control","git","regex","IDE","container","virtual machine"
        ],
      
        "Computer Science": [
          "computer","algorithm","data structure","database","machine learning","computing","cpu","gpu",
          "compiler theory","operating system","network","protocol","distributed system","cloud","virtualization",
          "encryption","cryptography","complexity","big o","neural network","ai","deep learning","nlp",
          "data mining","information theory","storage","cache","parallelism","graph","tree","binary","hashing",
          "blockchain","cybersecurity","quantum computing","software engineering","microarchitecture"
        ],
      
        "History": [
          "war","empire","revolution","histor","ancient","medieval","colonial",
          "civilization","dynasty","treaty","monarchy","republic","conquest","military","battle","renaissance",
          "industrial","cold war","world war","enlightenment","pharaoh","archaeology","imperialism",
          "feudalism","constitution","reform","rebellion","independence","exploration","migration",
          "cultural heritage","chronicle","historic event"
        ],
      
        "Geography": [
          "continent","country","climate","mountain","river","latitude","longitude","topography",
          "desert","ocean","island","plate tectonics","weather","region","urban","rural","population",
          "ecosystem","rainforest","volcano","earthquake","map","cartography","habitat","biome",
          "altitude","sea level","landform","delta","canyon","valley","glacier"
        ],
      
        "Literature": [
          "novel","poem","poetry","literature","character","narrative","prose",
          "metaphor","allegory","symbolism","theme","plot","drama","tragedy","comedy","author","genre",
          "fiction","nonfiction","myth","legend","epic","short story","rhetoric","dialogue",
          "narrator","memoir","biography","autobiography","manuscript","allusion","satire","imagery"
        ],
      
        "Language": [
          "grammar","vocabulary","sentence","syntax","linguistics","translation",
          "phonetics","phonology","morphology","semantics","pragmatics","dialect","accent","lexicon",
          "conjugation","declension","orthography","writing system","etymology","discourse","phrase",
          "idiom","bilingual","multilingual","pronunciation"
        ],
      
        "Art": [
          "painting","sculpture","canvas","gallery","museum","visual",
          "aesthetics","portrait","landscape","abstract","expressionism","realism","surrealism","impressionism",
          "installation","performance art","fine art","brushstroke","composition","color theory","perspective",
          "illustration","sketch","modern art","contemporary art","exhibit"
        ],
      
        "Music": [
          "melody","harmony","rhythm","instrument","composer","song","audio",
          "pitch","tempo","tone","timbre","scale","chord","genre","orchestra","symphony","opera","choir",
          "band","beat","lyrics","arrangement","composition","improvisation","acoustic","electronic",
          "soundtrack","mixing","recording","notation","conductor","performance"
        ],
      
        "Sports": [
          "tournament","score","player","match","athlete","game","league",
          "championship","coach","training","stadium","team","referee","offense","defense","tactics",
          "strategy","injury","endurance","competition","sportsmanship","record","ranking","event",
          "marathon","sprint","ball","equipment","playoff","fitness"
        ],
      
        "Entertainment": [
          "movie","film","television","celebrity","show","entertainment",
          "series","episode","director","actor","actress","script","screenplay","animation","cartoon",
          "streaming","documentary","thriller","comedy","drama","action","cinema","franchise",
          "soundtrack","visual effects","special effects","broadcast","media","trailer"
        ]
      };
      

      const normalizeDetected = (raw) => {
        if (!raw) return null;
        let s = raw.replace(/["“”‘’]/g, '').trim();
        // Take first line and remove trailing punctuation
        s = s.split('\n')[0].split('.')[0].trim();
        return s;
      };

      try {
        // Give the model more context if available (increase substring length)
        const snippet = (text && text.length > 0) ? text.substring(0, 2000) : "";
        const subjectResult = await model.generateContent({
          contents: [{ 
            role: "user", 
            parts: [{ 
              text: `Analyze this text and identify the single most appropriate academic subject it belongs to. Reply with ONLY one of these exact subjects (case-insensitive match will be accepted): ${allowedSubjects.map(s=>`"${s}"`).join(", ")}. Do not add any other text or explanation.

Text to analyze:
"${snippet}"`
            }] 
          }],
          generationConfig: {
            temperature: 0.0,
            maxOutputTokens: 30,
          },
        });

        const raw = subjectResult && subjectResult.response && subjectResult.response.text ? subjectResult.response.text().trim() : "";
        const cleaned = normalizeDetected(raw);
        console.log("Raw subject detection:", raw);
        console.log("Cleaned subject:", cleaned);

        // Heuristic scores computed from full text (always compute to allow voting)
        const textLower = (text || "").toLowerCase();
        const scores = {};
        for (const [subject, keywords] of Object.entries(keywordMap)) {
          scores[subject] = 0;
          for (const kw of keywords) {
            if (kw && textLower.includes(kw)) scores[subject] += 1;
          }
        }
        const sortedScores = Object.entries(scores).sort((a,b) => b[1]-a[1]);
        const best = sortedScores[0] || [null, 0];
        const heuristicSubject = best[0];
        const heuristicScore = best[1] || 0;
        console.log("Heuristic scores top:", heuristicSubject, heuristicScore);

        let modelMapped = null;
        if (cleaned) {
          // Exact case-insensitive match to allowed list
          const exact = allowedSubjects.find(s => s.toLowerCase() === cleaned.toLowerCase());
          if (exact) modelMapped = exact;

          // Substring match (e.g., "computer science" inside "Computer science")
          if (!modelMapped) {
            const contains = allowedSubjects.find(s => cleaned.toLowerCase().includes(s.toLowerCase()));
            if (contains) modelMapped = contains;
          }

          // Synonyms mapping
          if (!modelMapped) {
            for (const [k,v] of Object.entries(synonyms)) {
              if (cleaned.toLowerCase().includes(k)) {
                modelMapped = v;
                break;
              }
            }
          }
        }

        // Decision logic: prefer heuristic when it's strongly indicative
        if (modelMapped) {
          const modelScore = scores[modelMapped] || 0;
          console.log("Model mapped subject:", modelMapped, "modelScore:", modelScore);
          // If heuristic shows a clearly better signal than model's topic, prefer heuristic
          if (heuristicScore >= 2 && heuristicSubject !== modelMapped && heuristicScore > modelScore) {
            console.log("Choosing heuristic subject over model mapping ->", heuristicSubject);
            return heuristicSubject;
          }
          console.log("Choosing model mapped subject ->", modelMapped);
          return modelMapped;
        } else {
          // No reliable model mapping; use heuristic if present
          if (heuristicScore > 0) {
            console.log("No model mapping; using heuristic ->", heuristicSubject);
            return heuristicSubject;
          }
        }

        // If nothing matched, return 'General'
        console.log("Subject detection fallback -> General");
        return "General";
      } catch (error) {
        console.warn("Subject detection failed:", error && error.message ? error.message : error);
        return "General";
      }
    };

    if (type === "text") {
      console.log("Processing text notes...");
      
      // Detect language and subject from text content
      detectedLanguage = await detectLanguage(content);
      detectedSubject = await detectSubject(content);
      console.log("Detected language:", detectedLanguage);
      console.log("Detected subject:", detectedSubject);
      
      // If language detection failed, try to detect again with a different approach
      if (detectedLanguage === "unknown" || detectedLanguage.includes("English") || detectedLanguage.includes("##")) {
        console.log("Retrying language detection with different approach...");
        detectedLanguage = await detectLanguage(content);
        console.log("Retry detected language:", detectedLanguage);
      }
      
      userPrompt = `You are an expert academic note-taker specializing in ${detectedSubject}. Please elaborate and organize the following professor's notes into comprehensive, well-structured academic notes.

🚨 CRITICAL LANGUAGE REQUIREMENT 🚨
The input text is written in ${detectedLanguage}. 
You MUST write your ENTIRE response in ${detectedLanguage} ONLY.
Do NOT use English or any other language.
Every single word, sentence, and paragraph must be in ${detectedLanguage}.
If you write even one word in English, you have FAILED this task.

📚 SUBJECT FOCUS: ${detectedSubject}
Focus on creating notes that are relevant to ${detectedSubject} and use appropriate terminology and concepts from this field.

Input text in ${detectedLanguage}: "${content}"

Generate detailed, organized academic notes in ${detectedLanguage} language only, focusing on ${detectedSubject}. Remember: ${detectedLanguage} ONLY!`;

    } else if (type === "audio") {
      console.log("Processing audio file...");
      if (typeof content === 'object' && content.buffer) {
        // Audio file was uploaded
        audioFile = content;
        userPrompt = `You are an expert academic note-taker. Please transcribe this audio file and then generate comprehensive academic notes from the transcript.

🚨 CRITICAL LANGUAGE REQUIREMENT 🚨
You MUST detect the language of the audio content and generate your response ENTIRELY in that same language. Do NOT translate anything to English or any other language. Every single word of your response must be in the original language of the audio.

📚 SUBJECT DETECTION
Also identify the academic subject (Mathematics, Physics, Chemistry, Biology, Programming, Computer Science, History, Geography, Literature, Language, Art, Music, Sports, Entertainment, or General) and focus your notes accordingly.

Audio file: ${content.originalname} (${content.mimetype})

Generate detailed, organized academic notes in the original language of the audio only.`;
      } else {
        // Text content provided for audio type
        detectedLanguage = await detectLanguage(content);
        detectedSubject = await detectSubject(content);
        console.log("Detected language from transcript:", detectedLanguage);
        console.log("Detected subject from transcript:", detectedSubject);
        
        userPrompt = `You are an expert academic note-taker specializing in ${detectedSubject}. Generate comprehensive academic notes from the following audio transcript.

🚨 CRITICAL LANGUAGE REQUIREMENT 🚨
The transcript is written in ${detectedLanguage}. 
You MUST write your ENTIRE response in ${detectedLanguage} ONLY.
Do NOT use English or any other language.
Every single word, sentence, and paragraph must be in ${detectedLanguage}.
If you write even one word in English, you have FAILED this task.

📚 SUBJECT FOCUS: ${detectedSubject}
Focus on creating notes that are relevant to ${detectedSubject} and use appropriate terminology and concepts from this field.

Audio transcript in ${detectedLanguage}: "${content}"

Generate detailed, organized academic notes in ${detectedLanguage} language only, focusing on ${detectedSubject}. Remember: ${detectedLanguage} ONLY!`;
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

    let generatedNotes = result.response.text();

    // Validate and ensure the generated notes are in the correct language
    // Decide the target language: if detection failed, force English
    const targetLanguage = (detectedLanguage && detectedLanguage !== "unknown") ? detectedLanguage : 'English';
    try {
      const languageValidationResult = await model.generateContent({
        contents: [{ 
          role: "user", 
          parts: [{ 
            text: `🚨 URGENT LANGUAGE CORRECTION TASK 🚨\n\nThe following text should be written in ${targetLanguage}.\n\nYou MUST ensure the ENTIRE text is in ${targetLanguage} ONLY. Do NOT include words from other languages.\n\nOriginal text to correct:\n"${generatedNotes}"\n\nReturn ONLY the corrected text in ${targetLanguage}.` 
          }] 
        }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 2048,
        },
      });

      const validatedNotes = languageValidationResult.response.text();
      if (validatedNotes && validatedNotes.trim()) {
        generatedNotes = validatedNotes.trim();
        console.log("✅ Language validation and correction completed for", targetLanguage);
      }
    } catch (validationError) {
      console.warn("Language validation failed, using original notes:", validationError.message);
    }

    // Ensure we store the language as the target language (English when unknown)
    detectedLanguage = targetLanguage;

    // Prepare data for saving to database
    const noteData = {
      input_type: type,
      generated_notes: generatedNotes,
      detected_language: detectedLanguage,
      detected_subject: detectedSubject,
      original_content: typeof content === 'string' ? content : (content.originalname || 'audio_file')
    };

    // Ensure database connection
    const dbConnected = await ensureDBConnection();
    
    // Save notes to database (if connected)
    if (dbConnected) {
      try {
        const savedNote = await saveNotes(noteData);
        
        res.json({
          status: "success",
          input_type: type,
          model_used: GEMINI_MODEL,
          detected_language: detectedLanguage,
          detected_subject: detectedSubject,
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
          detected_language: detectedLanguage,
          detected_subject: detectedSubject,
          generated_notes: generatedNotes,
          note_id: null,
          save_error: "Notes generated but failed to save to database"
        });
      }
    } else {
      // Database not connected, return notes without saving
      res.json({
        status: "success",
        input_type: type,
        model_used: GEMINI_MODEL,
        detected_language: detectedLanguage,
        detected_subject: detectedSubject,
        generated_notes: generatedNotes,
        note_id: null,
        database_status: "Database not connected - notes not saved"
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

// --- Notes Management Routes ---
app.use("/api/notes", async (req, res, next) => {
  const dbConnected = await ensureDBConnection();
  if (!dbConnected) {
    return res.status(503).json({
      status: "error",
      message: "Database not connected. Notes management unavailable."
    });
  }
  next();
}, notesRoutes);

// --- Start Server ---
const startServer = async () => {
  try {
    // Try to connect to database (optional for serverless)
    isDatabaseConnected = await connectDB();
    
    // Start the server
    app.listen(PORT, () => {
      console.log(`\n✅ AI Notes Maker Server running at http://localhost:${PORT}`);
      console.log(`Model in use: ${GEMINI_MODEL}`);
      console.log(`Database: ${isDatabaseConnected ? 'Connected' : 'Not connected'}`);
      console.log(`\nReady to receive POST requests at /generate-notes`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error.message);
    process.exit(1);
  }
};

// For Vercel serverless, export the app directly
if (process.env.NODE_ENV === 'production') {
  module.exports = app;
} else {
  // Start the application locally
  startServer();
}