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
          "integral","integral","integral",
          "derivative","derivative","derivative",
          "algebra","algebra","algebra",
          "calculus","calculus","calculus",
          "theorem","theorem","theorem",
          "matrix","matrix","matrix",
          "probability","probability","probability",
          "geometry","geometry","geometry",
          "trigonometry","trigonometry","trigonometry",
          "statistics","statistics","statistics",
          "differential equations","differential equations","differential equations",
          "vector","vector","vector",
          "tensor","tensor","tensor",
          "limit","limit","limit",
          "set theory","set theory","set theory",
          "number theory","number theory","number theory",
          "topology","topology","topology",
          "combinatorics","combinatorics","combinatorics",
          "prime","prime","prime",
          "logarithm","logarithm","logarithm",
          "exponential","exponential","exponential",
          "polynomial","polynomial","polynomial",
          "inequality","inequality","inequality",
          "function","function","function",
          "graph theory","graph theory","graph theory",
          "optimization","optimization","optimization",
          "linear algebra","linear algebra","linear algebra",
          "stochastic","stochastic","stochastic",
          "random variable","random variable","random variable",
          "bayesian","bayesian","bayesian",
          "euclidean","euclidean","euclidean",
          "non-euclidean","non-euclidean","non-euclidean",
          "metric","metric","metric",
          "proof","proof","proof",
          "axiom","axiom","axiom",
          "lemma","lemma","lemma",
          "corollary","corollary","corollary",
          "sequence","sequence","sequence",
          "series","series","series",
          "p-adic","p-adic","p-adic",
          "symmetry","symmetry","symmetry",
          "group theory","group theory","group theory",
          "ring","ring","ring",
          "field","field","field",
          "manifold","manifold","manifold",
          "integrable","integrable","integrable",
          "partial derivative","partial derivative","partial derivative",
          "gradient","gradient","gradient",
          "divergence","divergence","divergence",
          "curl","curl","curl"
        ],
      
        "Physics": [
          "velocity","velocity","velocity",
          "force","force","force",
          "quantum","quantum","quantum",
          "relativity","relativity","relativity",
          "particle","particle","particle",
          "energy","energy","energy",
          "momentum","momentum","momentum",
          "thermodynamics","thermodynamics","thermodynamics",
          "optics","optics","optics",
          "mass","mass","mass",
          "acceleration","acceleration","acceleration",
          "friction","friction","friction",
          "gravity","gravity","gravity",
          "electromagnetism","electromagnetism","electromagnetism",
          "wave","wave","wave",
          "frequency","frequency","frequency",
          "amplitude","amplitude","amplitude",
          "spin","spin","spin",
          "string theory","string theory","string theory",
          "boson","boson","boson",
          "fermion","fermion","fermion",
          "neutrino","neutrino","neutrino",
          "photon","photon","photon",
          "entropy","entropy","entropy",
          "enthalpy","enthalpy","enthalpy",
          "pressure","pressure","pressure",
          "fluid dynamics","fluid dynamics","fluid dynamics",
          "nuclear","nuclear","nuclear",
          "atomic","atomic","atomic",
          "collision","collision","collision",
          "radiation","radiation","radiation",
          "magnetism","magnetism","magnetism",
          "capacitance","capacitance","capacitance",
          "resistance","resistance","resistance",
          "superconductivity","superconductivity","superconductivity",
          "black hole","black hole","black hole",
          "cosmology","cosmology","cosmology",
          "astrophysics","astrophysics","astrophysics",
          "inertia","inertia","inertia",
          "scalar","scalar","scalar",
          "vector","vector","vector",
          "field","field","field",
          "higgs","higgs","higgs",
          "dark matter","dark matter","dark matter",
          "dark energy","dark energy","dark energy",
          "interference","interference","interference",
          "diffraction","diffraction","diffraction",
          "relativistic","relativistic","relativistic"
        ],
      
        "Chemistry": [
          "molecule","molecule","molecule",
          "reaction","reaction","reaction",
          "chemical","chemical","chemical",
          "atom","atom","atom",
          "bond","bond","bond",
          "ph","ph","ph",
          "acid","acid","acid",
          "oxidation","oxidation","oxidation",
          "synthesis","synthesis","synthesis",
          "catalyst","catalyst","catalyst",
          "organic","organic","organic",
          "inorganic","inorganic","inorganic",
          "covalent","covalent","covalent",
          "ionic","ionic","ionic",
          "solution","solution","solution",
          "solvent","solvent","solvent",
          "solute","solute","solute",
          "concentration","concentration","concentration",
          "stoichiometry","stoichiometry","stoichiometry",
          "thermochemistry","thermochemistry","thermochemistry",
          "enthalpy","enthalpy","enthalpy",
          "electrons","electrons","electrons",
          "orbitals","orbitals","orbitals",
          "periodic table","periodic table","periodic table",
          "isotope","isotope","isotope",
          "polymer","polymer","polymer",
          "crystal","crystal","crystal",
          "precipitate","precipitate","precipitate",
          "titration","titration","titration",
          "spectroscopy","spectroscopy","spectroscopy",
          "chromatography","chromatography","chromatography",
          "equilibrium","equilibrium","equilibrium",
          "buffer","buffer","buffer",
          "alkaline","alkaline","alkaline",
          "halogen","halogen","halogen",
          "transition metal","transition metal","transition metal",
          "electrochemistry","electrochemistry","electrochemistry",
          "redox","redox","redox",
          "molarity","molarity","molarity",
          "kinetics","kinetics","kinetics",
          "hydrocarbon","hydrocarbon","hydrocarbon",
          "ester","ester","ester",
          "amine","amine","amine"
        ],
      
        "Biology": [
          "cell","cell","cell",
          "organism","organism","organism",
          "evolution","evolution","evolution",
          "dna","dna","dna",
          "protein","protein","protein",
          "genome","genome","genome",
          "photosynthesis","photosynthesis","photosynthesis",
          "mitosis","mitosis","mitosis",
          "meiosis","meiosis","meiosis",
          "enzyme","enzyme","enzyme",
          "chromosome","chromosome","chromosome",
          "ribosome","ribosome","ribosome",
          "mutation","mutation","mutation",
          "gene","gene","gene",
          "genetics","genetics","genetics",
          "epigenetics","epigenetics","epigenetics",
          "ecosystem","ecosystem","ecosystem",
          "bacteria","bacteria","bacteria",
          "virus","virus","virus",
          "fungi","fungi","fungi",
          "microbe","microbe","microbe",
          "adaptation","adaptation","adaptation",
          "natural selection","natural selection","natural selection",
          "anatomy","anatomy","anatomy",
          "physiology","physiology","physiology",
          "immune system","immune system","immune system",
          "respiration","respiration","respiration",
          "metabolism","metabolism","metabolism",
          "hormone","hormone","hormone",
          "organ","organ","organ",
          "species","species","species",
          "taxonomy","taxonomy","taxonomy",
          "reproduction","reproduction","reproduction",
          "biosphere","biosphere","biosphere",
          "ecology","ecology","ecology",
          "biome","biome","biome",
          "cloning","cloning","cloning",
          "biotechnology","biotechnology","biotechnology",
          "neuron","neuron","neuron",
          "synapse","synapse","synapse",
          "membrane","membrane","membrane",
          "cytoplasm","cytoplasm","cytoplasm",
          "mitochondria","mitochondria","mitochondria",
          "chloroplast","chloroplast","chloroplast"
        ],
      
        "Programming": [
          // original keywords (tripled)
          "function","function","function",
          "variable","variable","variable",
          "loop","loop","loop",
          "algorithm","algorithm","algorithm",
          "code","code","code",
          "compile","compile","compile",
          "runtime","runtime","runtime",
          "bug","bug","bug",
          "debug","debug","debug",
          "class","class","class",
          "object","object","object",
          "inheritance","inheritance","inheritance",
          "polymorphism","polymorphism","polymorphism",
          "interface","interface","interface",
          "recursion","recursion","recursion",
          "pointer","pointer","pointer",
          "array","array","array",
          "list","list","list",
          "dictionary","dictionary","dictionary",
          "hashmap","hashmap","hashmap",
          "framework","framework","framework",
          "library","library","library",
          "module","module","module",
          "package","package","package",
          "thread","thread","thread",
          "concurrency","concurrency","concurrency",
          "parallel","parallel","parallel",
          "asynchronous","asynchronous","asynchronous",
          "promise","promise","promise",
          "exception","exception","exception",
          "error","error","error",
          "syntax","syntax","syntax",
          "interpreter","interpreter","interpreter",
          "compiler","compiler","compiler",
          "optimization","optimization","optimization",
          "API","API","API",
          "REST","REST","REST",
          "JSON","JSON","JSON",
          "XML","XML","XML",
          "version control","version control","version control",
          "git","git","git",
          "regex","regex","regex",
          "IDE","IDE","IDE",
          "container","container","container",
          "virtual machine","virtual machine","virtual machine",
      
          // Expanded list of programming languages & related keywords (tripled)
          "C","C","C",
          "C++","C++","C++",
          "C#","C#","C#",
          "Java","Java","Java",
          "JavaScript","JavaScript","JavaScript",
          "TypeScript","TypeScript","TypeScript",
          "Python","Python","Python",
          "Ruby","Ruby","Ruby",
          "Go","Go","Go",
          "Golang","Golang","Golang",
          "Rust","Rust","Rust",
          "Swift","Swift","Swift",
          "Kotlin","Kotlin","Kotlin",
          "PHP","PHP","PHP",
          "Perl","Perl","Perl",
          "Haskell","Haskell","Haskell",
          "Scala","Scala","Scala",
          "R","R","R",
          "MATLAB","MATLAB","MATLAB",
          "Lua","Lua","Lua",
          "Objective-C","Objective-C","Objective-C",
          "Dart","Dart","Dart",
          "Visual Basic","Visual Basic","Visual Basic",
          "Fortran","Fortran","Fortran",
          "Assembly","Assembly","Assembly",
          "ASM","ASM","ASM",
          "Erlang","Erlang","Erlang",
          "Elixir","Elixir","Elixir",
          "COBOL","COBOL","COBOL",
          "Julia","Julia","Julia",
          "Shell","Shell","Shell",
          "Bash","Bash","Bash",
          "PowerShell","PowerShell","PowerShell",
          "SQL","SQL","SQL",
          "PL/SQL","PL/SQL","PL/SQL",
          "T-SQL","T-SQL","T-SQL",
          "Ada","Ada","Ada",
          "Prolog","Prolog","Prolog",
          "Lisp","Lisp","Lisp",
          "Scheme","Scheme","Scheme",
          "OCaml","OCaml","OCaml",
          "F#","F#","F#",
          "Groovy","Groovy","Groovy",
          "Smalltalk","Smalltalk","Smalltalk",
          "Crystal","Crystal","Crystal",
          "Nim","Nim","Nim",
          "Vala","Vala","Vala",
          "Solidity","Solidity","Solidity",
          "VHDL","VHDL","VHDL",
          "Verilog","Verilog","Verilog",
          "Apex","Apex","Apex",
          "ABAP","ABAP","ABAP",
          "ColdFusion","ColdFusion","ColdFusion",
          "Hack","Hack","Hack",
          "Tcl","Tcl","Tcl",
          "Racket","Racket","Racket",
          "D","D","D",
          "Zig","Zig","Zig",
          "Haxe","Haxe","Haxe",
          "Modula-2","Modula-2","Modula-2",
          "ML","ML","ML",
          "HLSL","HLSL","HLSL",
          "GLSL","GLSL","GLSL",
          "Smarty","Smarty","Smarty",
          "Handlebars","Handlebars","Handlebars",
          "Mustache","Mustache","Mustache",
          "XPath","XPath","XPath",
          "XQuery","XQuery","XQuery",
          "Puppet","Puppet","Puppet",
          "Chef","Chef","Chef",
          "Ansible","Ansible","Ansible",
          "Makefile","Makefile","Makefile",
          "Gradle","Gradle","Gradle",
          "Maven","Maven","Maven",
          "Emacs Lisp","Emacs Lisp","Emacs Lisp",
          "Raku","Raku","Raku",
          "COBOLScript","COBOLScript","COBOLScript",
          "OpenCL","OpenCL","OpenCL",
          "CUDA","CUDA","CUDA",
          "WebAssembly","WebAssembly","WebAssembly",
          "WASM","WASM","WASM",
          "Template","Template","Template",
          "Domain Specific Language","Domain Specific Language","Domain Specific Language"
        ],
      
        "Computer Science": [
          "computer","computer","computer",
          "algorithm","algorithm","algorithm",
          "data structure","data structure","data structure",
          "database","database","database",
          "machine learning","machine learning","machine learning",
          "computing","computing","computing",
          "cpu","cpu","cpu",
          "gpu","gpu","gpu",
          "compiler theory","compiler theory","compiler theory",
          "operating system","operating system","operating system",
          "network","network","network",
          "protocol","protocol","protocol",
          "distributed system","distributed system","distributed system",
          "cloud","cloud","cloud",
          "virtualization","virtualization","virtualization",
          "encryption","encryption","encryption",
          "cryptography","cryptography","cryptography",
          "complexity","complexity","complexity",
          "big o","big o","big o",
          "neural network","neural network","neural network",
          "ai","ai","ai",
          "deep learning","deep learning","deep learning",
          "nlp","nlp","nlp",
          "data mining","data mining","data mining",
          "information theory","information theory","information theory",
          "storage","storage","storage",
          "cache","cache","cache",
          "parallelism","parallelism","parallelism",
          "graph","graph","graph",
          "tree","tree","tree",
          "binary","binary","binary",
          "hashing","hashing","hashing",
          "blockchain","blockchain","blockchain",
          "cybersecurity","cybersecurity","cybersecurity",
          "quantum computing","quantum computing","quantum computing",
          "software engineering","software engineering","software engineering",
          "microarchitecture","microarchitecture","microarchitecture"
        ],
      
        "History": [
          "war","war","war",
          "empire","empire","empire",
          "revolution","revolution","revolution",
          "histor","histor","histor",
          "ancient","ancient","ancient",
          "medieval","medieval","medieval",
          "colonial","colonial","colonial",
          "civilization","civilization","civilization",
          "dynasty","dynasty","dynasty",
          "treaty","treaty","treaty",
          "monarchy","monarchy","monarchy",
          "republic","republic","republic",
          "conquest","conquest","conquest",
          "military","military","military",
          "battle","battle","battle",
          "renaissance","renaissance","renaissance",
          "industrial","industrial","industrial",
          "cold war","cold war","cold war",
          "world war","world war","world war",
          "enlightenment","enlightenment","enlightenment",
          "pharaoh","pharaoh","pharaoh",
          "archaeology","archaeology","archaeology",
          "imperialism","imperialism","imperialism",
          "feudalism","feudalism","feudalism",
          "constitution","constitution","constitution",
          "reform","reform","reform",
          "rebellion","rebellion","rebellion",
          "independence","independence","independence",
          "exploration","exploration","exploration",
          "migration","migration","migration",
          "cultural heritage","cultural heritage","cultural heritage",
          "chronicle","chronicle","chronicle",
          "historic event","historic event","historic event"
        ],
      
        "Geography": [
          "continent","continent","continent",
          "country","country","country",
          "climate","climate","climate",
          "mountain","mountain","mountain",
          "river","river","river",
          "latitude","latitude","latitude",
          "longitude","longitude","longitude",
          "topography","topography","topography",
          "desert","desert","desert",
          "ocean","ocean","ocean",
          "island","island","island",
          "plate tectonics","plate tectonics","plate tectonics",
          "weather","weather","weather",
          "region","region","region",
          "urban","urban","urban",
          "rural","rural","rural",
          "population","population","population",
          "ecosystem","ecosystem","ecosystem",
          "rainforest","rainforest","rainforest",
          "volcano","volcano","volcano",
          "earthquake","earthquake","earthquake",
          "map","map","map",
          "cartography","cartography","cartography",
          "habitat","habitat","habitat",
          "biome","biome","biome",
          "altitude","altitude","altitude",
          "sea level","sea level","sea level",
          "landform","landform","landform",
          "delta","delta","delta",
          "canyon","canyon","canyon",
          "valley","valley","valley",
          "glacier","glacier","glacier"
        ],
      
        "Literature": [
          "novel","novel","novel",
          "poem","poem","poem",
          "poetry","poetry","poetry",
          "literature","literature","literature",
          "character","character","character",
          "narrative","narrative","narrative",
          "prose","prose","prose",
          "metaphor","metaphor","metaphor",
          "allegory","allegory","allegory",
          "symbolism","symbolism","symbolism",
          "theme","theme","theme",
          "plot","plot","plot",
          "drama","drama","drama",
          "tragedy","tragedy","tragedy",
          "comedy","comedy","comedy",
          "author","author","author",
          "genre","genre","genre",
          "fiction","fiction","fiction",
          "nonfiction","nonfiction","nonfiction",
          "myth","myth","myth",
          "legend","legend","legend",
          "epic","epic","epic",
          "short story","short story","short story",
          "rhetoric","rhetoric","rhetoric",
          "dialogue","dialogue","dialogue",
          "narrator","narrator","narrator",
          "memoir","memoir","memoir",
          "biography","biography","biography",
          "autobiography","autobiography","autobiography",
          "manuscript","manuscript","manuscript",
          "allusion","allusion","allusion",
          "satire","satire","satire",
          "imagery","imagery","imagery"
        ],
      
        "Language": [
          "grammar","grammar","grammar",
          "vocabulary","vocabulary","vocabulary",
          "sentence","sentence","sentence",
          "syntax","syntax","syntax",
          "linguistics","linguistics","linguistics",
          "translation","translation","translation",
          "phonetics","phonetics","phonetics",
          "phonology","phonology","phonology",
          "morphology","morphology","morphology",
          "semantics","semantics","semantics",
          "pragmatics","pragmatics","pragmatics",
          "dialect","dialect","dialect",
          "accent","accent","accent",
          "lexicon","lexicon","lexicon",
          "conjugation","conjugation","conjugation",
          "declension","declension","declension",
          "orthography","orthography","orthography",
          "writing system","writing system","writing system",
          "etymology","etymology","etymology",
          "discourse","discourse","discourse",
          "phrase","phrase","phrase",
          "idiom","idiom","idiom",
          "bilingual","bilingual","bilingual",
          "multilingual","multilingual","multilingual",
          "pronunciation","pronunciation","pronunciation"
        ],
      
        "Art": [
          "painting","painting","painting",
          "sculpture","sculpture","sculpture",
          "canvas","canvas","canvas",
          "gallery","gallery","gallery",
          "museum","museum","museum",
          "visual","visual","visual",
          "aesthetics","aesthetics","aesthetics",
          "portrait","portrait","portrait",
          "landscape","landscape","landscape",
          "abstract","abstract","abstract",
          "expressionism","expressionism","expressionism",
          "realism","realism","realism",
          "surrealism","surrealism","surrealism",
          "impressionism","impressionism","impressionism",
          "installation","installation","installation",
          "performance art","performance art","performance art",
          "fine art","fine art","fine art",
          "brushstroke","brushstroke","brushstroke",
          "composition","composition","composition",
          "color theory","color theory","color theory",
          "perspective","perspective","perspective",
          "illustration","illustration","illustration",
          "sketch","sketch","sketch",
          "modern art","modern art","modern art",
          "contemporary art","contemporary art","contemporary art",
          "exhibit","exhibit","exhibit"
        ],
      
        "Music": [
          "melody","melody","melody",
          "harmony","harmony","harmony",
          "rhythm","rhythm","rhythm",
          "instrument","instrument","instrument",
          "composer","composer","composer",
          "song","song","song",
          "audio","audio","audio",
          "pitch","pitch","pitch",
          "tempo","tempo","tempo",
          "tone","tone","tone",
          "timbre","timbre","timbre",
          "scale","scale","scale",
          "chord","chord","chord",
          "genre","genre","genre",
          "orchestra","orchestra","orchestra",
          "symphony","symphony","symphony",
          "opera","opera","opera",
          "choir","choir","choir",
          "band","band","band",
          "beat","beat","beat",
          "lyrics","lyrics","lyrics",
          "arrangement","arrangement","arrangement",
          "composition","composition","composition",
          "improvisation","improvisation","improvisation",
          "acoustic","acoustic","acoustic",
          "electronic","electronic","electronic",
          "soundtrack","soundtrack","soundtrack",
          "mixing","mixing","mixing",
          "recording","recording","recording",
          "notation","notation","notation",
          "conductor","conductor","conductor",
          "performance","performance","performance"
        ],
      
        "Sports": [
          "tournament","tournament","tournament",
          "score","score","score",
          "player","player","player",
          "match","match","match",
          "athlete","athlete","athlete",
          "game","game","game",
          "league","league","league",
          "championship","championship","championship",
          "coach","coach","coach",
          "training","training","training",
          "stadium","stadium","stadium",
          "team","team","team",
          "referee","referee","referee",
          "offense","offense","offense",
          "defense","defense","defense",
          "tactics","tactics","tactics",
          "strategy","strategy","strategy",
          "injury","injury","injury",
          "endurance","endurance","endurance",
          "competition","competition","competition",
          "sportsmanship","sportsmanship","sportsmanship",
          "record","record","record",
          "ranking","ranking","ranking",
          "event","event","event",
          "marathon","marathon","marathon",
          "sprint","sprint","sprint",
          "ball","ball","ball",
          "equipment","equipment","equipment",
          "playoff","playoff","playoff",
          "fitness","fitness","fitness"
        ],
      
        "Entertainment": [
          "movie","movie","movie",
          "film","film","film",
          "television","television","television",
          "celebrity","celebrity","celebrity",
          "show","show","show",
          "entertainment","entertainment","entertainment",
          "series","series","series",
          "episode","episode","episode",
          "director","director","director",
          "actor","actor","actor",
          "actress","actress","actress",
          "script","script","script",
          "screenplay","screenplay","screenplay",
          "animation","animation","animation",
          "cartoon","cartoon","cartoon",
          "streaming","streaming","streaming",
          "documentary","documentary","documentary",
          "thriller","thriller","thriller",
          "comedy","comedy","comedy",
          "drama","drama","drama",
          "action","action","action",
          "cinema","cinema","cinema",
          "franchise","franchise","franchise",
          "soundtrack","soundtrack","soundtrack",
          "visual effects","visual effects","visual effects",
          "special effects","special effects","special effects",
          "broadcast","broadcast","broadcast",
          "media","media","media",
          "trailer","trailer","trailer"
        ]
      };
      
      // Create a focused, formatted excerpt from the raw text to improve subject detection.
      // The goal is to surface titles, headings, math/formula lines and other high-signal lines
      // so the model and heuristics see the most relevant parts first.
      const formatForSubjectDetection = (raw) => {
        if (!raw || typeof raw !== "string") return "";
        const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        if (lines.length === 0) return "";

        // Title: first non-empty short line
        const title = lines.find(l => l.length > 0 && l.length < 120) || lines[0];

        // Headings: lines that look like headings (markdown hashes) or ALL CAPS short lines
        const headings = lines.filter(l => /^#+\s+/.test(l) || (l === l.toUpperCase() && l.split(' ').length < 8));

        // Math/formula indicators (LaTeX tokens, common math words, operators)
        const mathRegexStr = '\\\\frac|\\\\sum|\\\\int|\\\\sqrt|\\\\theta|\\\\alpha|\\\\beta|\\d+\\\\s*=|\\\\bderivative\\\\b|\\^|sin\\\\(|cos\\\\(|tan\\\\(|lim\\\\b|=>|<=|>=';
        const mathRegex = new RegExp(mathRegexStr, 'i');
        const mathLines = lines.filter(l => mathRegex.test(l));

        // Unit / physics/chemistry cues
        const unitRegex = new RegExp('\\b(m|cm|mm|kg|g|mol|N|Pa|J|W|Hz|K|ppm)\\b');
        const unitLines = lines.filter(l => unitRegex.test(l));

        // Keyword-rich lines (definitions, theorems, algorithms, reactions, etc.)
        const signalRegex = new RegExp('\\b(definition|theorem|proof|lemma|example|algorithm|reaction|synthesis|transcript|transcription|study guide|exercise|solution|procedure)\\b', 'i');
        const signalLines = lines.filter(l => signalRegex.test(l));

        // Take the beginning of the document (first 60 lines) as context
        const headLines = lines.slice(0, 60);

        // Compose prioritized excerpt: title, headings, math, units, signals, then head
        const excerptParts = [];
        if (title) excerptParts.push(title);
        if (headings.length) excerptParts.push(...headings.slice(0, 6));
        if (mathLines.length) excerptParts.push(...mathLines.slice(0, 12));
        if (unitLines.length) excerptParts.push(...unitLines.slice(0, 8));
        if (signalLines.length) excerptParts.push(...signalLines.slice(0, 10));
        excerptParts.push(...headLines);

        const composed = excerptParts.join("\n").replace(/["“”‘’]/g, '').trim();
        // Limit to a reasonable length for model input
        return composed.length > 4000 ? composed.substring(0, 4000) : composed;
      };
      
      

      const normalizeDetected = (raw) => {
        if (!raw) return null;
        let s = raw.replace(/["“”‘’]/g, '').trim();
        // Take first line and remove trailing punctuation
        s = s.split('\n')[0].split('.')[0].trim();
        return s;
      };

      try {
        // Pre-format the raw text to surface the highest-signal lines for subject detection.
        const formattedSnippet = formatForSubjectDetection(text);
        const modelInput = formattedSnippet && formattedSnippet.length > 0 ? formattedSnippet : (text && text.length > 0 ? text.substring(0, 2000) : "");
        const allowedList = allowedSubjects.map(s => `"${s}"`).join(", ");
        const subjectResult = await model.generateContent({
          contents: [{ 
            role: "user", 
            parts: [{ 
              text: `Analyze this excerpt (pre-formatted to surface titles, headings and formulas) and identify the single most appropriate academic subject it belongs to. Reply with ONLY one of these exact subjects (case-insensitive match will be accepted): ${allowedList}. Do not add any other text or explanation.

Excerpt:
"${modelInput}"`
            }] 
          }],
          generationConfig: {
            temperature: 0.0,
            maxOutputTokens: 40,
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

    // --- Post-generation subject re-check & override ---
    // Re-evaluate the subject using the generated notes + original content and prefer the stronger signal.
    const postDetectSubject = (generatedText, originalContent, currentSubject) => {
      try {
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
          "sport": "Sports",
          "entertainment": "Entertainment",
          "general": "General"
        };

        const smallKeywordMap = {
          "Sports": [
            "player","team","coach","tournament","match","score","goal","stadium",
            "athlete","training","league","referee","offense","defense","marathon",
            "sprint","competition","fitness","game","scoreboard","coach"
          ],
          "Programming": ["function","variable","algorithm","code","compile","runtime","bug","debug","array","json","api","javascript","python","java"],
          "Mathematics": ["integral","derivative","calculus","algebra","matrix","theorem","probability","statistics","geometry","trigonometry"],
          "Physics": ["force","quantum","relativity","momentum","energy","velocity","gravity","entropy","thermodynamics","optics"],
          "Chemistry": ["molecule","reaction","atom","bond","ph","catalyst","organic","inorganic","stoichiometry","spectroscopy"],
          "Biology": ["cell","dna","genome","protein","photosynthesis","mitosis","meiosis","enzyme","organism","ecology"],
          "History": ["war","empire","revolution","ancient","medieval","dynasty","treaty","colonial","civilization"],
          "Geography": ["continent","country","climate","latitude","longitude","topography","river","mountain","ocean","map"],
          "Literature": ["novel","poem","poetry","character","narrative","prose","metaphor","plot","drama","genre"],
          "Language": ["grammar","vocabulary","syntax","linguistics","translation","phonetics","morphology","semantics"],
          "Art": ["painting","sculpture","canvas","gallery","museum","aesthetics","portrait","landscape"],
          "Music": ["melody","harmony","rhythm","instrument","composer","song","pitch","tempo"],
          "Entertainment": ["movie","film","television","celebrity","series","episode","director","actor","script"]
        };

        const getTextForAnalysis = () => {
          const g = generatedText || "";
          const o = (typeof originalContent === 'string') ? originalContent : (originalContent && originalContent.originalname ? originalContent.originalname : "");
          return (g + "\n" + o).toLowerCase();
        };

        const text = getTextForAnalysis();
        if (!text || text.trim().length === 0) return currentSubject;

        // 1) Direct allowed-subject mention (strong signal)
        for (const s of allowedSubjects) {
          if (text.includes(s.toLowerCase())) return s;
        }

        // 2) Synonym mention
        for (const [k, v] of Object.entries(synonyms)) {
          if (text.includes(k)) return v;
        }

        // 3) Heuristic keyword scoring across smallKeywordMap
        const scores = {};
        for (const [subject, kws] of Object.entries(smallKeywordMap)) {
          scores[subject] = 0;
          for (const kw of kws) {
            if (kw && text.includes(kw)) scores[subject] += 1;
          }
        }

        const sorted = Object.entries(scores).sort((a,b) => b[1] - a[1]);
        const top = sorted[0] || [null, 0];
        const second = sorted[1] || [null, 0];

        // Strong heuristic: top has at least 3 matches and is ahead of second by >=2
        if (top[1] >= 3 && (top[1] - (second[1] || 0) >= 2)) {
          return top[0];
        }

        // Sports is common and can be decided with a lower threshold if several keywords appear
        if (scores["Sports"] >= 2) return "Sports";

        return currentSubject;
      } catch (err) {
        console.warn("Post-generation subject re-check failed:", err && err.message ? err.message : err);
        return currentSubject;
      }
    };

    try {
      const overridden = postDetectSubject(generatedNotes, content, detectedSubject);
      if (overridden && overridden !== detectedSubject) {
        console.log("Post-generation subject override triggered. Previous subject:", detectedSubject, "-> New subject:", overridden);
        detectedSubject = overridden;
      }
    } catch (e) {
      console.warn("Error during post-generation subject override:", e && e.message ? e.message : e);
    }

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