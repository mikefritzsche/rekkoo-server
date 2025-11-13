const express = require('express');
const { authenticateJWT } = require('../auth/middleware');
const { sendSupportEmail } = require('../services/emailService');

const router = express.Router();

const sanitize = (value, max = 4000) => {
  if (!value) return '';
  const str = String(value);
  return str.length > max ? str.slice(0, max) : str;
};

const supportRateLimit = new Map();
const SUPPORT_WINDOW = 60 * 60 * 1000; // 1 hour
const SUPPORT_MAX_REQUESTS = 3;

const supportLimiter = (req, res, next) => {
  const userId = req.user.id;
  const now = Date.now();

  if (!supportRateLimit.has(userId)) {
    supportRateLimit.set(userId, { count: 0, resetTime: now + SUPPORT_WINDOW });
  }

  const entry = supportRateLimit.get(userId);

  if (now > entry.resetTime) {
    entry.count = 0;
    entry.resetTime = now + SUPPORT_WINDOW;
  }

  if (entry.count >= SUPPORT_MAX_REQUESTS) {
    return res.status(429).json({
      message: 'Too many support requests. Please try again later.',
      retry_after: Math.ceil((entry.resetTime - now) / 1000),
    });
  }

  entry.count += 1;
  next();
};

router.post('/contact', authenticateJWT, supportLimiter, async (req, res) => {
  try {
    const { subject, message, include_metadata: includeMetadata = true, context = {} } = req.body || {};

    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ message: 'Message is required' });
    }

    const payload = {
      fromEmail: req.user.email,
      fromName: req.user.username || req.user.email,
      subject: sanitize(subject || 'Support request'),
      message: sanitize(message),
      metadata: includeMetadata
        ? {
            userId: req.user.id,
            userEmail: req.user.email,
            context,
            submittedAt: new Date().toISOString(),
          }
        : {},
    };

    await sendSupportEmail(payload);

    return res.json({ success: true });
  } catch (err) {
    console.error('[SupportRoutes] Failed to send support email', err);
    return res.status(500).json({ message: 'Unable to send support message' });
  }
});

module.exports = router;
