const db = require('../config/db');
const { v4: uuidv4 } = require('uuid');
const { sendNotificationEmail } = require('./emailService');

const allowsEmailNotifications = (preferences = {}) => {
  if (!preferences || typeof preferences !== 'object') {
    return true;
  }

  const directKeys = ['email_notifications', 'emailInvitations', 'email'];
  const explicitOptOut = directKeys.some((key) => preferences[key] === false);
  if (explicitOptOut) {
    return false;
  }

  const nestedChannels = [
    ['notificationChannels', 'email'],
    ['channels', 'email'],
    ['invitations', 'email'],
  ];

  for (const [root, child] of nestedChannels) {
    const branch = preferences[root];
    if (branch && typeof branch === 'object' && branch[child] === false) {
      return false;
    }
  }

  const explicitAllow = directKeys
    .map((key) => preferences[key])
    .filter((value) => typeof value === 'boolean');

  if (explicitAllow.length > 0) {
    return explicitAllow.some((value) => value === true);
  }

  return true;
};

const readBooleanPreference = (preferences = {}, ...keys) => {
  const flattened = preferences || {};
  for (const keyPath of keys) {
    const segments = Array.isArray(keyPath) ? keyPath : [keyPath];
    let current = flattened;
    for (const segment of segments) {
      if (!current || typeof current !== 'object') {
        current = undefined;
        break;
      }
      current = current[segment];
    }
    if (typeof current === 'boolean') {
      return current;
    }
  }
  return undefined;
};

const allowsSecretSantaEmail = (preferences = {}) => {
  const explicit = readBooleanPreference(preferences, 'secret_santa_email', ['secretSanta', 'email'], ['secret_santa', 'email']);
  if (typeof explicit === 'boolean') {
    return explicit;
  }
  return allowsEmailNotifications(preferences);
};

const allowsSecretSantaPush = (preferences = {}) => {
  const explicit = readBooleanPreference(preferences, 'secret_santa_push', ['secretSanta', 'push'], ['secret_santa', 'push']);
  if (typeof explicit === 'boolean') {
    return explicit;
  }
  return true;
};

class NotificationService {
  constructor() {
    this.socketService = null;
  }

  setSocketService(socketService) {
    this.socketService = socketService;
  }

  emitSocketEvent(userId, event, payload = {}) {
    if (!this.socketService || !event) return;
    try {
      this.socketService.notifyUser(userId, event, payload);
    } catch (err) {
      console.error('[NotificationService] Failed to emit socket event:', event, 'user:', userId, err);
    }
  }

  // Create in-app notification
  async createNotification({ userId, type, title, message, data = {} }) {
    try {
      const notificationId = uuidv4();
      const { rows } = await db.query(
        `INSERT INTO notifications (id, user_id, notification_type, title, body, entity_type, entity_id, is_read)
         VALUES ($1, $2, $3, $4, $5, $6, $7, false)
         RETURNING *`,
        [notificationId, userId, type, title, message, data.entity_type || 'gift_item', data.entity_id || data.reservation_id || null]
      );
      
      return rows[0];
    } catch (error) {
      console.error('Error creating notification:', error);
      throw error;
    }
  }

  // Send email notification
  async sendEmail({ to, subject, html, text }) {
    if (!to || !subject || !html) {
      console.warn('[NotificationService] Missing fields for sendEmail', {
        hasTo: !!to,
        hasSubject: !!subject,
        hasHtml: !!html,
      });
      return;
    }

    try {
      const result = await sendNotificationEmail({
        toEmail: to,
        subject,
        htmlContent: html,
        textContent: text,
      });
      return result;
    } catch (error) {
      console.error('Error sending email:', error);
      // Don't throw - email failure shouldn't break the flow
    }
  }

  async fetchUsersWithPreferences(userIds = []) {
    const normalized = Array.from(
      new Set((userIds || []).map((id) => String(id))).values()
    ).filter(Boolean);
    if (!normalized.length) {
      return [];
    }

    const { rows } = await db.query(
      `SELECT u.id,
              u.email,
              u.username,
              u.full_name,
              COALESCE(us.notification_preferences, '{}'::jsonb) AS notification_preferences
         FROM users u
         LEFT JOIN user_settings us ON us.user_id = u.id
        WHERE u.id = ANY($1::uuid[])
          AND u.deleted_at IS NULL`,
      [normalized]
    );
    return rows;
  }

  async fetchListManagers(listId, excludeUserIds = []) {
    if (!listId) {
      return [];
    }
    const excludeSet = new Set(
      (excludeUserIds || []).map((id) => String(id)).filter(Boolean)
    );
    const { rows } = await db.query(
      `WITH managers AS (
          SELECT l.owner_id AS user_id
            FROM lists l
           WHERE l.id = $1
          UNION
        SELECT lc.user_id
            FROM list_collaborators lc
           WHERE lc.list_id = $1
             AND lc.permission IN ('admin','edit')
        )
        SELECT u.id,
               u.email,
               u.username,
               u.full_name,
               COALESCE(us.notification_preferences, '{}'::jsonb) AS notification_preferences
          FROM users u
          LEFT JOIN user_settings us ON us.user_id = u.id
         WHERE u.id IN (SELECT user_id FROM managers)
           AND u.deleted_at IS NULL`,
      [listId]
    );
    const unique = new Map(
      rows.map((row) => [String(row.id), row])
    );
    return Array.from(unique.values()).filter(
      (row) => !excludeSet.has(String(row.id))
    );
  }

  async getUserDisplayName(userId) {
    if (!userId) {
      return null;
    }
    const { rows } = await db.query(
      `SELECT full_name, username, email
         FROM users
        WHERE id = $1
          AND deleted_at IS NULL`,
      [userId]
    );
    if (!rows.length) {
      return null;
    }
    const record = rows[0];
    return record.full_name || record.username || record.email || null;
  }

  buildSecretSantaCopy(event, { actorName, listTitle, participantSummary, exchangeDateLabel }) {
    switch (event) {
      case 'participant_invited':
        return {
          title: `Secret Santa invite on ${listTitle}`,
          message: `${actorName || 'Someone'} invited you to join the Secret Santa round on "${listTitle}".`,
          emailSubject: `You're invited to ${listTitle} Secret Santa`,
          emailHtml: `
            <p>${actorName || 'Someone'} invited you to participate in the Secret Santa round for <strong>${listTitle}</strong>.</p>
            ${
              exchangeDateLabel
                ? `<p><strong>Exchange date:</strong> ${exchangeDateLabel}</p>`
                : ''
            }
            <p>Open Rekkoo to review the details and accept or decline.</p>
          `,
        };
      case 'participant_removed':
        return {
          title: `Removed from ${listTitle} Secret Santa`,
          message: `${actorName || 'An organizer'} removed you from the Secret Santa round on "${listTitle}".`,
          emailSubject: `Removed from ${listTitle} Secret Santa`,
          emailHtml: `
            <p>${actorName || 'An organizer'} removed you from the Secret Santa round for <strong>${listTitle}</strong>.</p>
            <p>If this was unexpected, reach out to the list owner for details.</p>
          `,
        };
      case 'participant_accepted':
        return {
          title: 'Secret Santa participant accepted',
          message: `${participantSummary || 'A participant'} accepted the invite for "${listTitle}".`,
          emailSubject: `${participantSummary || 'Participant'} accepted your Secret Santa invite`,
          emailHtml: `
            <p><strong>${participantSummary || 'A participant'}</strong> accepted the Secret Santa invite for <strong>${listTitle}</strong>.</p>
            ${
              exchangeDateLabel
                ? `<p>The exchange is scheduled for ${exchangeDateLabel}.</p>`
                : ''
            }
            <p>You can proceed once enough participants have accepted.</p>
          `,
        };
      case 'participant_declined':
        return {
          title: 'Secret Santa participant declined',
          message: `${participantSummary || 'A participant'} declined the Secret Santa invite for "${listTitle}".`,
          emailSubject: `${participantSummary || 'Participant'} declined your Secret Santa invite`,
          emailHtml: `
            <p><strong>${participantSummary || 'A participant'}</strong> declined the Secret Santa invite for <strong>${listTitle}</strong>.</p>
            <p>Consider inviting someone else or adjusting the participant list.</p>
          `,
        };
      default:
        return null;
    }
  }

  async notifySecretSantaParticipants({ event, listId, roundId, actorId, targetUserIds = [] }) {
    if (!event || !listId || !roundId) {
      return;
    }

    const normalizedTargets = Array.from(
      new Set((targetUserIds || []).map((id) => String(id))).values()
    ).filter(Boolean);
    if (['participant_invited', 'participant_removed'].includes(event) && !normalizedTargets.length) {
      return;
    }

    const [{ rows: listRows }, { rows: roundRows }] = await Promise.all([
      db.query(
        `SELECT id, title
           FROM lists
          WHERE id = $1`,
        [listId]
      ),
      db.query(
        `SELECT id, list_id, exchange_date
           FROM secret_santa_rounds
          WHERE id = $1`,
        [roundId]
      ),
    ]);

    if (!listRows.length) {
      return;
    }

    const listTitle = listRows[0].title || 'your list';
    const round = roundRows[0] || {};
    const exchangeDateLabel = round.exchange_date
      ? new Date(round.exchange_date).toLocaleDateString()
      : null;
    const actorName = (await this.getUserDisplayName(actorId)) || null;

    const targetUsers = normalizedTargets.length
      ? await this.fetchUsersWithPreferences(normalizedTargets)
      : [];

    const participantSummary = targetUsers
      .map((user) => user.full_name || user.username || user.email || 'Participant')
      .join(', ');

    let recipients = [];
    if (event === 'participant_invited' || event === 'participant_removed') {
      recipients = targetUsers;
    } else if (event === 'participant_accepted' || event === 'participant_declined') {
      recipients = await this.fetchListManagers(listId, actorId ? [actorId] : []);
    }

    if (!recipients.length) {
      return;
    }

    const notificationTypeMap = {
      participant_invited: 'secret_santa_invite',
      participant_removed: 'secret_santa_removed',
      participant_accepted: 'secret_santa_participant_update',
      participant_declined: 'secret_santa_participant_update',
    };

    const socketEventMap = {
      participant_invited: 'secret_santa:participant_invited',
      participant_removed: 'secret_santa:participant_removed',
      participant_accepted: 'secret_santa:participant_status',
      participant_declined: 'secret_santa:participant_status',
    };

    const baseData = {
      entity_type: 'secret_santa_rounds',
      entity_id: roundId,
      list_id: listId,
      round_id: roundId,
      list_title: listTitle,
      event,
      participant_ids: normalizedTargets,
    };

    const content = this.buildSecretSantaCopy(event, {
      actorName,
      listTitle,
      participantSummary,
      exchangeDateLabel,
    });
    if (!content) {
      return;
    }

    await Promise.all(
      recipients.map(async (recipient) => {
        const prefs = recipient.notification_preferences || {};
        if (allowsSecretSantaPush(prefs)) {
          await this.createNotification({
            userId: recipient.id,
            type: notificationTypeMap[event] || 'secret_santa_event',
            title: content.title,
            message: content.message,
            data: baseData,
          });

          const socketEvent = socketEventMap[event];
          if (socketEvent) {
            this.emitSocketEvent(recipient.id, socketEvent, {
              ...baseData,
              recipientId: recipient.id,
            });
          }
        }

        if (
          recipient.email &&
          allowsSecretSantaEmail(prefs) &&
          content.emailSubject &&
          content.emailHtml
        ) {
          await this.sendEmail({
            to: recipient.email,
            subject: content.emailSubject,
            html: content.emailHtml,
          });
        }
      })
    );
  }

  // Notify all group members about an action
  async notifyGroupMembers({ listId, excludeUserId, type, data }) {
    try {
      // Gather all collaborators who should be notified (legacy group_members, new collab groups, direct overrides)
      const { rows: accessRecipients } = await db.query(
        `WITH legacy_group_members AS (
           SELECT DISTINCT gm.user_id
           FROM group_members gm
           JOIN list_sharing ls ON gm.group_id = ls.shared_with_group_id
           WHERE ls.list_id = $1
             AND gm.user_id != $2
             AND gm.deleted_at IS NULL
             AND ls.deleted_at IS NULL
         ),
         collab_group_members AS (
           SELECT DISTINCT cgm.user_id
           FROM list_group_roles lgr
           JOIN collaboration_group_members cgm ON lgr.group_id = cgm.group_id
           WHERE lgr.list_id = $1
             AND cgm.user_id != $2
             AND lgr.deleted_at IS NULL
             AND cgm.deleted_at IS NULL
           UNION
           SELECT DISTINCT cgm.user_id
           FROM list_sharing ls
           JOIN collaboration_group_members cgm ON ls.shared_with_group_id = cgm.group_id
           WHERE ls.list_id = $1
             AND cgm.user_id != $2
             AND ls.deleted_at IS NULL
             AND cgm.deleted_at IS NULL
         ),
         direct_users AS (
           SELECT DISTINCT luo.user_id
           FROM list_user_overrides luo
           WHERE luo.list_id = $1
             AND luo.user_id != $2
             AND luo.role != 'blocked'
             AND luo.deleted_at IS NULL
         ),
         combined AS (
           SELECT user_id FROM legacy_group_members
           UNION
           SELECT user_id FROM collab_group_members
           UNION
           SELECT user_id FROM direct_users
         )
         SELECT DISTINCT
           u.id,
           u.email,
           u.username,
           u.full_name,
           COALESCE(us.notification_preferences, '{}'::jsonb) AS notification_preferences
         FROM users u
         LEFT JOIN user_settings us ON us.user_id = u.id
         WHERE u.deleted_at IS NULL
           AND u.id IN (SELECT user_id FROM combined)`,
        [listId, excludeUserId]
      );

      // Get list owner as well (if not excluded)
      const { rows: listOwner } = await db.query(
        `SELECT 
           u.id,
           u.email,
           u.username,
           u.full_name,
           COALESCE(us.notification_preferences, '{}'::jsonb) AS notification_preferences
         FROM users u
         LEFT JOIN user_settings us ON us.user_id = u.id
         JOIN lists l ON u.id = l.owner_id
         WHERE l.id = $1 AND u.id != $2 AND u.deleted_at IS NULL`,
        [listId, excludeUserId]
      );

      const listOwnerRecipients = listOwner.length ? listOwner : [];
      const allRecipients = [...accessRecipients, ...listOwnerRecipients];
      const uniqueRecipients = Array.from(new Map(allRecipients.map(r => [r.id, r])).values());

      const socketEventMap = {
        item_reserved: 'gift:item:reserved',
        item_purchased: 'gift:item:purchased',
        reservation_released: 'gift:item:released',
        purchase_released: 'gift:item:released',
        shared_purchase_update: 'gift:sharedPurchase:changed',
      };
      const socketEvent = socketEventMap[type] || null;
      const socketPayloadBase = {
        listId,
        type,
        data,
        timestamp: new Date().toISOString(),
      };
      const silentNotificationTypes = new Set(['shared_purchase_update']);

      // Prepare notification content based on type
      let title, message, emailSubject, emailHtml;
      
      switch (type) {
        case 'item_reserved':
          title = 'Gift Reserved';
          message = `${data.reserved_by} has reserved "${data.item_title}" from ${data.list_title}`;
          emailSubject = `Gift Reserved: ${data.item_title}`;
          emailHtml = `
            <h2>Gift Reserved</h2>
            <p><strong>${data.reserved_by}</strong> has reserved the following gift:</p>
            <ul>
              <li>Item: ${data.item_title}</li>
              <li>List: ${data.list_title}</li>
            </ul>
          `;
          break;
          
        case 'item_purchased':
          title = 'Gift Purchased';
          message = `${data.purchased_by} has purchased "${data.item_title}" from ${data.list_title}`;
          emailSubject = `Gift Purchased: ${data.item_title}`;
          emailHtml = `
            <h2>Gift Purchased</h2>
            <p><strong>${data.purchased_by}</strong> has purchased the following gift:</p>
            <ul>
              <li>Item: ${data.item_title}</li>
              <li>List: ${data.list_title}</li>
            </ul>
          `;
          break;
          
        case 'reservation_released':
          title = 'Reservation Released';
          message = `${data.released_by} has released their reservation for "${data.item_title}"`;
          emailSubject = `Reservation Released: ${data.item_title}`;
          emailHtml = `
            <h2>Reservation Released</h2>
            <p><strong>${data.released_by}</strong> has released their reservation for:</p>
            <ul>
              <li>Item: ${data.item_title}</li>
              <li>List: ${data.list_title}</li>
            </ul>
            <p>This item is now available for reservation.</p>
          `;
          break;
          
        case 'purchase_released':
          title = 'Purchase Released';
          message = `${data.released_by} has released their purchase for "${data.item_title}"`;
          emailSubject = `Purchase Released: ${data.item_title}`;
          emailHtml = `
            <h2>Purchase Released</h2>
            <p><strong>${data.released_by}</strong> has released their purchase for:</p>
            <ul>
              <li>Item: ${data.item_title}</li>
              <li>List: ${data.list_title}</li>
            </ul>
            <p>This item is now available for reservation or purchase.</p>
          `;
          break;
          
        case 'shared_purchase_update':
          title = 'Shared purchase updated';
          message = `Shared purchase activity on ${data.list_title || 'a list'}`;
          emailSubject = null;
          emailHtml = null;
          break;
        
        default:
          title = 'List Activity';
          message = `Activity on ${data.list_title}`;
          emailSubject = 'List Activity';
          emailHtml = `<p>There has been activity on the list: ${data.list_title}</p>`;
      }

      // Send notifications to each recipient
      const notificationPromises = uniqueRecipients.map(async (recipient) => {
        if (!silentNotificationTypes.has(type)) {
          await this.createNotification({
            userId: recipient.id,
            type,
            title,
            message,
            data
          });

          const prefs = recipient.notification_preferences || {};
          if (allowsEmailNotifications(prefs) && recipient.email && emailSubject && emailHtml) {
            await this.sendEmail({
              to: recipient.email,
              subject: emailSubject,
              html: emailHtml
            });
          }
        }

        if (socketEvent) {
          this.emitSocketEvent(recipient.id, socketEvent, {
            ...socketPayloadBase,
            recipientId: recipient.id,
          });
        }
      });

      await Promise.all(notificationPromises);
      
      console.log(`Sent ${type} notifications to ${uniqueRecipients.length} recipients`);
      
    } catch (error) {
      console.error('Error notifying group members:', error);
      // Don't throw - notification failure shouldn't break the main flow
    }
  }

  // Mark notifications as read
  async markAsRead(notificationIds, userId) {
    try {
      const { rows } = await db.query(
        `UPDATE notifications 
         SET is_read = true, read_at = CURRENT_TIMESTAMP
         WHERE id = ANY($1) AND user_id = $2
         RETURNING *`,
        [notificationIds, userId]
      );
      
      return rows;
    } catch (error) {
      console.error('Error marking notifications as read:', error);
      throw error;
    }
  }

  // Get unread notifications for a user
  async getUnreadNotifications(userId) {
    try {
      const { rows } = await db.query(
        `SELECT * FROM notifications
         WHERE user_id = $1 AND is_read = false AND deleted_at IS NULL
         ORDER BY created_at DESC
         LIMIT 50`,
        [userId]
      );
      
      return rows;
    } catch (error) {
      console.error('Error fetching unread notifications:', error);
      throw error;
    }
  }
}

module.exports = new NotificationService();
