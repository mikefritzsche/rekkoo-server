const db = require('../config/db');
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');

class NotificationService {
  constructor() {
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
      // Get all group members who have access to this list
      const { rows: members } = await db.query(
        `SELECT DISTINCT u.id, u.email, u.username, u.full_name, u.notification_preferences
         FROM users u
         JOIN group_members gm ON u.id = gm.user_id
         JOIN list_sharing ls ON gm.group_id = ls.shared_with_group_id
         WHERE ls.list_id = $1 
           AND u.id != $2
           AND u.deleted_at IS NULL
           AND gm.deleted_at IS NULL
           AND ls.deleted_at IS NULL`,
        [listId, excludeUserId]
      );

      // Get list owner as well (if not excluded)
      const { rows: listOwner } = await db.query(
        `SELECT u.id, u.email, u.username, u.full_name, u.notification_preferences
         FROM users u
         JOIN lists l ON u.id = l.owner_id
         WHERE l.id = $1 AND u.id != $2 AND u.deleted_at IS NULL`,
        [listId, excludeUserId]
      );

      const allRecipients = [...members, ...listOwner[0] ? listOwner : []];
      const uniqueRecipients = Array.from(new Map(allRecipients.map(r => [r.id, r])).values());

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
          
        default:
          title = 'List Activity';
          message = `Activity on ${data.list_title}`;
          emailSubject = 'List Activity';
          emailHtml = `<p>There has been activity on the list: ${data.list_title}</p>`;
      }

      // Send notifications to each recipient
      const notificationPromises = uniqueRecipients.map(async (recipient) => {
        // Create in-app notification
        await this.createNotification({
          userId: recipient.id,
          type,
          title,
          message,
          data
        });

        // Send email if user has email notifications enabled
        const prefs = recipient.notification_preferences || {};
        if (prefs.email_notifications !== false && recipient.email) {
          await this.sendEmail({
            to: recipient.email,
            subject: emailSubject,
            html: emailHtml
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