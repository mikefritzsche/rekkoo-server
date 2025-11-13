const BugReportsService = require('../services/bugReportsService');
const { logger } = require('../utils/logger');

function parseArrayParam(value) {
  if (!value) return undefined;
  if (Array.isArray(value)) {
    return value.filter(Boolean);
  }
  return String(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function extractIpAddress(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip;
}

function createBugReportsController() {
  const service = new BugReportsService();

  const createBugReport = async (req, res) => {
    try {
      const {
        title,
        description,
        repro_steps: reproStepsSnake,
        reproSteps: reproStepsCamel,
        category,
        impact,
        channel,
        metadata,
        source_context: sourceContextSnake,
        sourceContext: sourceContextCamel,
        include_metadata: includeMetadataSnake,
        includeMetadata: includeMetadataCamel,
        platform,
        locale,
      } = req.body || {};

      const report = await service.createReport({
        user: req.user,
        title,
        description,
        reproSteps: reproStepsCamel ?? reproStepsSnake,
        category,
        impact,
        channel,
        metadata,
        sourceContext: sourceContextCamel ?? sourceContextSnake,
        includeEnvironmentMetadata: (includeMetadataCamel ?? includeMetadataSnake) !== false,
        headers: req.headers,
        ipAddress: extractIpAddress(req),
        platform,
        locale,
      });

      return res.status(201).json({ report });
    } catch (error) {
      logger.error('[BugReportsController] Failed to submit bug report', error);
      const status = error.statusCode || (error.message?.includes('required') ? 400 : 500);
      return res.status(status).json({ message: error.message || 'Unable to submit bug report' });
    }
  };

  const listBugReports = async (req, res) => {
    try {
      const { limit, offset, reporter_id: reporterId, search, from, to } = req.query || {};
      const status = parseArrayParam(req.query?.status);
      const impact = parseArrayParam(req.query?.impact);
      const category = parseArrayParam(req.query?.category);

      const reports = await service.listReports({
        limit,
        offset,
        filters: {
          status,
          impact,
          category,
          reporterId,
          search,
          from,
          to,
        },
      });

      return res.json({ reports });
    } catch (error) {
      logger.error('[BugReportsController] Failed to list bug reports', error);
      return res.status(500).json({ message: 'Unable to load bug reports' });
    }
  };

  const getMyBugReports = async (req, res) => {
    try {
      const { limit, offset } = req.query || {};
      const reports = await service.listReportsForUser(req.user.id, { limit, offset });
      return res.json({ reports });
    } catch (error) {
      logger.error('[BugReportsController] Failed to load user bug reports', error);
      return res.status(500).json({ message: 'Unable to load your bug reports' });
    }
  };

  const updateBugReport = async (req, res) => {
    try {
      const { status, impact, category, assignee_id: assigneeId, note } = req.body || {};
      const updated = await service.updateReport(req.params.id, {
        status,
        impact,
        category,
        assigneeId,
        note,
        actorId: req.user?.id,
      });
      return res.json({ report: updated });
    } catch (error) {
      logger.error('[BugReportsController] Failed to update bug report', error);
      const statusCode = error.statusCode || 500;
      return res.status(statusCode).json({ message: error.message || 'Unable to update bug report' });
    }
  };

  return {
    createBugReport,
    listBugReports,
    getMyBugReports,
    updateBugReport,
  };
}

module.exports = createBugReportsController;
