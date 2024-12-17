// routes/auth.js
const express = require('express');
const router = express.Router();
const authController = require('../auth/controllers');
const { authenticateToken } = require('../auth/middleware');

router.post('/register', authController.register);
router.post('/login', authController.login);
router.get('/profile', authenticateToken, authController.getProfile);

module.exports = router;
