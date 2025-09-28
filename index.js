const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;

// MongoDB connection
let mongoStatus = 'disconnected';

mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => {
    mongoStatus = 'connected';
    console.log('MongoDB connected');
  })
  .catch((err) => {
    mongoStatus = 'error';
    console.error('MongoDB connection error:', err);
  });

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// MongoDB connection status endpoint
app.get('/api/mongo', (req, res) => {
  res.status(200).json({ mongoStatus });
});

// Default route
app.get('/', (req, res) => {
  res.send('Welcome to the basic Node.js server on Vercel');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
