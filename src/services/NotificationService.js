const db = require('../config/db');
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');

class NotificationService {
  constructor() {
    this.socketService = null;
    // Initialize email transporter if email config is available
    if (process.env.SMTP_HOST && process.env.SMTP_USER) {
      this.emailTransporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: process.env.SMTP_PORT || 587,
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        }
      });
    }
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
    if (!this.emailTransporter) {
      console.log('Email transporter not configured, skipping email notification');
      return;
    }

    try {
      const mailOptions = {
        from: process.env.SMTP_FROM || 'noreply@rekkoo.com',
        to,
        subject,
        html,
        text: text || html.replace(/<[^>]*>/g, '') // Strip HTML tags for text version
      };

      const result = await this.emailTransporter.sendMail(mailOptions);
      console.log('Email sent successfully:', result.messageId);
      return result;
    } catch (error) {
      console.error('Error sending email:', error);
      // Don't throw - email failure shouldn't break the flow
    }
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
          if (prefs.email_notifications !== false && recipient.email && emailSubject && emailHtml) {
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
