const Note = require('../models/Note');

// Save generated notes to database
const saveNotes = async (noteData) => {
  try {
    const note = new Note({
      inputType: noteData.input_type,
      generatedNotes: noteData.generated_notes
    });

    const savedNote = await note.save();
    console.log('✅ Notes saved to database:', savedNote._id);
    return savedNote;
  } catch (error) {
    console.error('❌ Error saving notes to database:', error.message);
    throw error;
  }
};

// Get all notes
const getAllNotes = async (req, res) => {
  try {
    const notes = await Note.find().sort({ createdAt: -1 });
    res.json({
      status: 'success',
      count: notes.length,
      notes: notes
    });
  } catch (error) {
    console.error('❌ Error fetching notes:', error.message);
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch notes',
      error: error.message
    });
  }
};

// Get a specific note by ID
const getNoteById = async (req, res) => {
  try {
    const note = await Note.findById(req.params.id);
    if (!note) {
      return res.status(404).json({
        status: 'error',
        message: 'Note not found'
      });
    }
    res.json({
      status: 'success',
      note: note
    });
  } catch (error) {
    console.error('❌ Error fetching note:', error.message);
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch note',
      error: error.message
    });
  }
};

// Delete a note by ID
const deleteNote = async (req, res) => {
  try {
    const note = await Note.findByIdAndDelete(req.params.id);
    if (!note) {
      return res.status(404).json({
        status: 'error',
        message: 'Note not found'
      });
    }
    res.json({
      status: 'success',
      message: 'Note deleted successfully',
      deletedNote: note
    });
  } catch (error) {
    console.error('❌ Error deleting note:', error.message);
    res.status(500).json({
      status: 'error',
      message: 'Failed to delete note',
      error: error.message
    });
  }
};

module.exports = {
  saveNotes,
  getAllNotes,
  getNoteById,
  deleteNote
};
