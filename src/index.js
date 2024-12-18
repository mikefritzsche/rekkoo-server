const express = require('express');
// const db = require('./config/db');
const bcrypt = require('bcrypt');
const saltRounds = 12;
const userRoutes = require('./routes/user.routes');
const authRoutes = require('./routes/auth');

// v0.0.1

const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Routes
// app.use('/api/v1.0/users', userRoutes);
// app.use('/api/v1.0/auth', authRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ message: 'Something went wrong!' });
});

app.get('/api/v1.0/health', (req, res) => {
  res.json({ status: 'ok', message: 'Rekko Health Check Successful' });
});
app.get('/', (req, res) => {
  res.json({ message: 'Welcome to Rekkoo' });
});

app.get('/api/v1.0', (req, res) => {
  res.json({ message: 'Welcome to Rekkoo API' });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
