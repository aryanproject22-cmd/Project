const express = require('express');
const app = express();

const PORT = process.env.PORT || 3000;

// Basic health check endpoint
app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Optional: default route
app.get('/', (req, res) => {
  res.send('Welcome to the basic Node.js server on Vercel');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
