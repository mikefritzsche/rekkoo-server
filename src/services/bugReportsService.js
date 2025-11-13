const { v4: uuidv4 } = require('uuid');
const fetch = require('node-fetch');
const db = require('../config/db');
const { logger } = require('../utils/logger');

const BUG_REPORT_IP_CAPTURE_ENABLED = process.env.BUG_REPORT_CAPTURE_IP === 'true';
const BUG_REPORT_SLACK_WEBHOOK_URL = process.env.BUG_REPORT_SLACK_WEBHOOK_URL || '';
const BUG_REPORT_MAX_TEXT = parseInt(process.env.BUG_REPORT_MAX_FIELD_LENGTH || '4000', 10);

const HIGH_IMPACT_LEVELS = new Set(['blocker', 'high']);

class BugReportsService {
  constructor() {
    this.allowedCategories = new Set(['ui', 'performance', 'sync', 'data', 'other']);
    this.allowedImpact = new Set(['blocker', 'high', 'medium', 'low']);
    this.allowedChannels = new Set(['web', 'ios', 'android', 'desktop', 'api']);
    this.allowedStatus = new Set(['open', 'triaged', 'in_progress', 'resolved', 'wont_fix', 'duplicate']);
  }

  sanitizeText(value, maxLength = BUG_REPORT_MAX_TEXT) {
    if (value === undefined || value === null) {
      return null;
    }
    const str = String(value).trim();
    if (!str) return null;
    return str.length > maxLength ? str.slice(0, maxLength) : str;
  }

  safeJson(value, fallback = {}) {
    if (!value) return { ...fallback };
    if (typeof value === 'object') {
      try {
        return JSON.parse(JSON.stringify(value));
      } catch {
        return { ...fallback };
      }
    }
    if (typeof value === 'string') {
      try {
        return JSON.parse(value);
      } catch (err) {
        logger.warn('[BugReportsService] Failed to parse JSON payload, falling back to empty object');
        return { ...fallback };
      }
    }
    return { ...fallback };
  }

  normalizeValue(value, allowedSet, fallback) {
    if (!value) return fallback;
    const normalized = String(value).toLowerCase();
    return allowedSet.has(normalized) ? normalized : fallback;
  }

  buildReferenceCode(id) {
    return id.replace(/-/g, '').slice(0, 8).toUpperCase();
  }

  buildMetadata(baseMetadata, { includeEnvironment, headers, ipAddress, user, platform, locale }) {
    let metadata = this.safeJson(baseMetadata);

    if (includeEnvironment) {
      metadata = {
        ...metadata,
        app_version: headers['x-app-version'] || metadata.app_version || null,
        build_number: headers['x-build-number'] || metadata.build_number || null,
        device_model: headers['x-device-model'] || metadata.device_model || null,
        os_version: headers['x-os-version'] || metadata.os_version || null,
        platform: platform || headers['x-platform'] || metadata.platform || null,
        locale: locale || headers['x-locale'] || metadata.locale || null,
        network_state: headers['x-network-state'] || metadata.network_state || null,
        feature_flags: this.parseFeatureFlags(headers['x-feature-flags'], metadata.feature_flags),
        user_agent: headers['user-agent'] || metadata.user_agent || null,
        server_timestamp: new Date().toISOString(),
        reporter_email: user?.email || null,
        reporter_id: user?.id || null,
      };

      if (BUG_REPORT_IP_CAPTURE_ENABLED) {
        metadata.reporter_ip = ipAddress || metadata.reporter_ip || null;
      }
    }

    return metadata;
  }

  parseFeatureFlags(value, fallback) {
    if (!value) return fallback || null;
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
      try {
        if (value.trim().startsWith('[')) {
          return JSON.parse(value);
        }
        return value.split(',').map(flag => flag.trim()).filter(Boolean);
      } catch {
        return fallback || null;
      }
    }
    return fallback || null;
  }

  formatRow(row) {
    if (!row) return null;
    const metadata = this.safeJson(row.metadata, {});
    const sourceContext = this.safeJson(row.source_context, {});

    return {
      ...row,
      metadata,
      source_context: sourceContext,
      reporter: row.reporter_id
        ? {
            id: row.reporter_id,
            email: row.reporter_email,
            username: row.reporter_username,
            full_name: row.reporter_full_name,
          }
        : null,
      assignee: row.assignee_id
        ? {
            id: row.assignee_id,
            email: row.assignee_email,
            username: row.assignee_username,
            full_name: row.assignee_full_name,
          }
        : null,
    };
  }

  async createReport({
    user,
    title,
    description,
    reproSteps,
    category,
    impact,
    channel,
    metadata,
    sourceContext,
    includeEnvironmentMetadata,
    headers,
    ipAddress,
    platform,
    locale,
  }) {
    const sanitizedTitle = this.sanitizeText(title, 200);
    const sanitizedDescription = this.sanitizeText(description);

    if (!sanitizedTitle || !sanitizedDescription) {
      const error = new Error('Title and description are required.');
      error.statusCode = 400;
      throw error;
    }

    const sanitizedReproSteps = this.sanitizeText(reproSteps);
    const normalizedCategory = this.normalizeValue(category, this.allowedCategories, 'other');
    const normalizedImpact = this.normalizeValue(impact, this.allowedImpact, 'medium');
    const normalizedChannel = this.normalizeValue(channel, this.allowedChannels, 'web');

    const finalMetadata = this.buildMetadata(metadata, {
      includeEnvironment: includeEnvironmentMetadata !== false,
      headers,
      ipAddress,
      user,
      platform,
      locale,
    });
    const finalSourceContext = this.safeJson(sourceContext, {});

    const id = uuidv4();
    const referenceCode = this.buildReferenceCode(id);

    const insertQuery = `
      INSERT INTO bug_reports (
        id,
        reference_code,
        reported_by,
        channel,
        title,
        description,
        repro_steps,
        category,
        impact,
        metadata,
        source_context
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb)
      RETURNING *
    `;

    const params = [
      id,
      referenceCode,
      user?.id || null,
      normalizedChannel,
      sanitizedTitle,
      sanitizedDescription,
      sanitizedReproSteps,
      normalizedCategory,
      normalizedImpact,
      JSON.stringify(finalMetadata),
      JSON.stringify(finalSourceContext),
    ];

    const { rows } = await db.query(insertQuery, params);
    const created = await this.hydrateRow(rows[0]);

    this.notifyHighImpact(created).catch((err) => {
      logger.error('[BugReportsService] Failed to send Slack notification:', err.message);
    });

    return created;
  }

  async hydrateRow(row) {
    if (!row) return null;
    const query = `
      SELECT
        br.*,
        reporter.id AS reporter_id,
        reporter.email AS reporter_email,
        reporter.username AS reporter_username,
        reporter.full_name AS reporter_full_name,
        assignee.id AS assignee_id,
        assignee.email AS assignee_email,
        assignee.username AS assignee_username,
        assignee.full_name AS assignee_full_name
      FROM bug_reports br
      LEFT JOIN users reporter ON reporter.id = br.reported_by
      LEFT JOIN users assignee ON assignee.id = br.assignee_id
      WHERE br.id = $1
    `;
    const { rows: hydratedRows } = await db.query(query, [row.id]);
    return this.formatRow(hydratedRows[0] || row);
  }

  buildListFilters({ status, impact, category, reporterId, search, from, to }) {
    const conditions = [];
    const params = [];

    const pushArrayFilter = (values, column, allowedSet) => {
      if (!values?.length) return;
      const validValues = values
        .map((value) => this.normalizeValue(value, allowedSet, null))
        .filter(Boolean);

      if (validValues.length) {
        params.push(validValues);
        conditions.push(`${column} = ANY($${params.length}::text[])`);
      }
    };

    pushArrayFilter(status, 'br.status', this.allowedStatus);
    pushArrayFilter(impact, 'br.impact', this.allowedImpact);
    pushArrayFilter(category, 'br.category', this.allowedCategories);

    if (reporterId) {
      params.push(reporterId);
      conditions.push('br.reported_by = $' + params.length);
    }

    if (search) {
      params.push(`%${search}%`);
      conditions.push('(br.title ILIKE $' + params.length + ' OR br.description ILIKE $' + params.length + ')');
    }

    if (from) {
      params.push(from);
      conditions.push('br.created_at >= $' + params.length);
    }

    if (to) {
      params.push(to);
      conditions.push('br.created_at <= $' + params.length);
    }

    return { conditions, params };
  }

  async listReports({ limit = 50, offset = 0, filters = {} }) {
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 200);
    const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);
    const { conditions, params } = this.buildListFilters(filters);

    params.push(safeLimit);
    params.push(safeOffset);

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const query = `
      SELECT
        br.*,
        reporter.id AS reporter_id,
        reporter.email AS reporter_email,
        reporter.username AS reporter_username,
        reporter.full_name AS reporter_full_name,
        assignee.id AS assignee_id,
        assignee.email AS assignee_email,
        assignee.username AS assignee_username,
        assignee.full_name AS assignee_full_name
      FROM bug_reports br
      LEFT JOIN users reporter ON reporter.id = br.reported_by
      LEFT JOIN users assignee ON assignee.id = br.assignee_id
      ${whereClause}
      ORDER BY br.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `;

    const { rows } = await db.query(query, params);
    return rows.map((row) => this.formatRow(row));
  }

  async listReportsForUser(userId, { limit = 50, offset = 0 } = {}) {
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 100);
    const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);

    const query = `
      SELECT
        br.*,
        reporter.id AS reporter_id,
        reporter.email AS reporter_email,
        reporter.username AS reporter_username,
        reporter.full_name AS reporter_full_name,
        assignee.id AS assignee_id,
        assignee.email AS assignee_email,
        assignee.username AS assignee_username,
        assignee.full_name AS assignee_full_name
      FROM bug_reports br
      LEFT JOIN users reporter ON reporter.id = br.reported_by
      LEFT JOIN users assignee ON assignee.id = br.assignee_id
      WHERE br.reported_by = $1
      ORDER BY br.created_at DESC
      LIMIT $2 OFFSET $3
    `;

    const { rows } = await db.query(query, [userId, safeLimit, safeOffset]);
    return rows.map((row) => this.formatRow(row));
  }

  async updateReport(id, { status, impact, category, assigneeId, note, actorId }) {
    const existing = await this.getRawReport(id);
    if (!existing) {
      const error = new Error('Bug report not found');
      error.statusCode = 404;
      throw error;
    }

    const updates = [];
    const params = [];

    const applyUpdate = (column, value) => {
      params.push(value);
      updates.push(`${column} = $${params.length}`);
    };

    if (status) {
      const normalizedStatus = this.normalizeValue(status, this.allowedStatus, null);
      if (!normalizedStatus) {
        const error = new Error('Invalid status value');
        error.statusCode = 400;
        throw error;
      }
      applyUpdate('status', normalizedStatus);

      if (normalizedStatus !== 'open' && !existing.acknowledged_at) {
        applyUpdate('acknowledged_at', new Date().toISOString());
      }

      if (['resolved', 'wont_fix', 'duplicate'].includes(normalizedStatus)) {
        applyUpdate('resolved_at', new Date().toISOString());
      } else if (existing.resolved_at) {
        applyUpdate('resolved_at', null);
      }
    }

    if (impact) {
      const normalizedImpact = this.normalizeValue(impact, this.allowedImpact, null);
      if (!normalizedImpact) {
        const error = new Error('Invalid impact value');
        error.statusCode = 400;
        throw error;
      }
      applyUpdate('impact', normalizedImpact);
    }

    if (category) {
      const normalizedCategory = this.normalizeValue(category, this.allowedCategories, null);
      if (!normalizedCategory) {
        const error = new Error('Invalid category value');
        error.statusCode = 400;
        throw error;
      }
      applyUpdate('category', normalizedCategory);
    }

    if (assigneeId !== undefined) {
      applyUpdate('assignee_id', assigneeId || null);
    }

    if (!updates.length && !note) {
      return this.hydrateRow(existing);
    }

    params.push(id);
    const updateQuery = `
      UPDATE bug_reports
      SET ${updates.join(', ')}
      WHERE id = $${params.length}
      RETURNING *
    `;

    let updatedRow = existing;
    if (updates.length) {
      const { rows } = await db.query(updateQuery, params);
      updatedRow = rows[0];
    }

    if (note) {
      await db.query(
        `INSERT INTO bug_report_notes (bug_report_id, author_id, note)
         VALUES ($1, $2, $3)`,
        [id, actorId || null, this.sanitizeText(note, 2000)]
      );
    }

    const hydrated = await this.hydrateRow(updatedRow);

    if (status && HIGH_IMPACT_LEVELS.has(hydrated?.impact)) {
      this.notifyHighImpact(hydrated).catch((err) => {
        logger.error('[BugReportsService] Failed to send Slack notification after update:', err.message);
      });
    }

    return hydrated;
  }

  async getRawReport(id) {
    const { rows } = await db.query('SELECT * FROM bug_reports WHERE id = $1', [id]);
    return rows[0] || null;
  }

  async notifyHighImpact(report) {
    if (!report || !BUG_REPORT_SLACK_WEBHOOK_URL) {
      return;
    }

    if (!HIGH_IMPACT_LEVELS.has(report.impact)) {
      return;
    }

    try {
      await fetch(BUG_REPORT_SLACK_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: [
            `:rotating_light: *${report.impact.toUpperCase()} bug reported*`,
            `*${report.title}*`,
            `Reporter: ${report.reporter?.email || 'unknown'} (${report.channel})`,
            `Category: ${report.category} | Status: ${report.status}`,
            `Reference: ${report.reference_code}`,
            report.metadata?.app_version ? `App: v${report.metadata.app_version}` : null,
            report.metadata?.platform ? `Platform: ${report.metadata.platform}` : null,
            '',
            report.description ? `> ${report.description}` : null,
          ]
            .filter(Boolean)
            .join('\n'),
        }),
      });
    } catch (error) {
      logger.error('[BugReportsService] Slack webhook failed', error);
    }
  }
}

module.exports = BugReportsService;
