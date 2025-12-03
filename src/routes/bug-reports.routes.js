const express = require('express');
const { authenticateJWT } = require('../auth/middleware');
const db = require('../config/db');
const createBugReportsController = require('../controllers/BugReportsController');

const BUG_REPORTING_ENABLED = process.env.ENABLE_BUG_REPORTING === 'true';
const BUG_REPORTING_REQUIRE_BETA = process.env.BUG_REPORTING_REQUIRE_BETA === 'true';
const BUG_REPORTING_ALLOWED_ROLES = (process.env.BUG_REPORTING_ALLOWED_ROLES || 'admin,beta,beta_tester')
  .split(',')
  .map((role) => role.trim())
  .filter(Boolean);
const BUG_REPORTING_ALLOWED_EMAILS = (process.env.BUG_REPORTING_ALLOWED_EMAILS || '')
  .split(',')
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean);

const BUG_REPORTS_PER_WINDOW = parseInt(process.env.BUG_REPORT_MAX_PER_WINDOW || '5', 10);
const BUG_REPORT_WINDOW_MINUTES = parseInt(process.env.BUG_REPORT_WINDOW_MINUTES || '60', 10);
const RATE_LIMIT_WINDOW_MS = BUG_REPORT_WINDOW_MINUTES * 60 * 1000;

const submissionTracker = new Map();
const router = express.Router();
const controller = createBugReportsController();

const ensureEnabled = (req, res, next) => {
  if (!BUG_REPORTING_ENABLED) {
    return res.status(404).json({ message: 'Bug reporting is disabled' });
  }
  return next();
};

const requireEligibility = async (req, res, next) => {
  if (!BUG_REPORTING_REQUIRE_BETA) {
    return next();
  }

  if (!req.user?.id) {
    return res.status(401).json({ message: 'Authentication required' });
  }

  if (BUG_REPORTING_ALLOWED_EMAILS.includes((req.user.email || '').toLowerCase())) {
    return next();
  }

  if (!BUG_REPORTING_ALLOWED_ROLES.length) {
    return next();
  }

  try {
    const { rows } = await db.query(
      `SELECT 1
       FROM user_roles ur
       JOIN roles r ON ur.role_id = r.id
       WHERE ur.user_id = $1
         AND r.name = ANY($2::text[])
       LIMIT 1`,
      [req.user.id, BUG_REPORTING_ALLOWED_ROLES]
    );

    if (!rows.length) {
      return res.status(403).json({
        message: 'Bug reporting is currently limited to beta testers. Please contact support if you need access.',
      });
    }

    return next();
  } catch (error) {
    console.error('[BugReportsRoutes] Failed to verify eligibility', error);
    return res.status(500).json({ message: 'Unable to verify bug reporting access' });
  }
};

const requireAdminAccess = async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT 1
       FROM user_roles ur
       JOIN roles r ON ur.role_id = r.id
       WHERE ur.user_id = $1
         AND r.name IN ('admin', 'super_admin')
       LIMIT 1`,
      [req.user?.id]
    );

    if (!rows.length) {
      return res.status(403).json({ message: 'Admin access required' });
    }

    return next();
  } catch (error) {
    console.error('[BugReportsRoutes] Admin check failed', error);
    return res.status(500).json({ message: 'Unable to verify permissions' });
  }
};

const applyRateLimit = (req, res, next) => {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ message: 'Authentication required' });
  }

  const now = Date.now();
  const current = submissionTracker.get(userId) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };

  if (now > current.resetAt) {
    current.count = 0;
    current.resetAt = now + RATE_LIMIT_WINDOW_MS;
  }

  if (current.count >= BUG_REPORTS_PER_WINDOW) {
    const minutes = Math.ceil((current.resetAt - now) / 60000);
    return res.status(429).json({
      message: `You have reached the bug report limit. Please try again in ${minutes} minute(s).`,
    });
  }

  current.count += 1;
  submissionTracker.set(userId, current);
  return next();
};

router.post('/', authenticateJWT, ensureEnabled, requireEligibility, applyRateLimit, controller.createBugReport);

router.get('/my', authenticateJWT, ensureEnabled, requireEligibility, controller.getMyBugReports);

router.get('/', authenticateJWT, ensureEnabled, requireAdminAccess, controller.listBugReports);

router.patch('/:id', authenticateJWT, ensureEnabled, requireAdminAccess, controller.updateBugReport);

module.exports = router;
