const db = require('../config/db');
const { DEFAULT_NOTIFICATION_PREFERENCES } = require('./notificationPreferences');

async function hydrateNotificationPreferences() {
  try {
    const { rowCount } = await db.query(
      `UPDATE user_settings
       SET notification_preferences = $1,
           updated_at = NOW()
       WHERE notification_preferences IS NULL
          OR jsonb_typeof(notification_preferences) != 'object'
          OR jsonb_object_length(notification_preferences) = 0
          OR (notification_preferences->>'email_notifications') IS NULL
          OR (notification_preferences->>'emailInvitations') IS NULL
          OR jsonb_typeof(notification_preferences->'channels') != 'object'
          OR ((notification_preferences->'channels')->>'email') IS NULL
          OR ((notification_preferences->'channels')->>'push') IS NULL
          OR jsonb_typeof(notification_preferences->'marketing') != 'object'
          OR ((notification_preferences->'marketing')->>'newsletters') IS NULL
          OR ((notification_preferences->'marketing')->>'productUpdates') IS NULL
          OR ((notification_preferences->'marketing')->>'promotions') IS NULL`,
      [DEFAULT_NOTIFICATION_PREFERENCES]
    );

    if (rowCount > 0) {
      console.log(`[NotificationPreferences] Hydrated defaults for ${rowCount} user(s).`);
    }
  } catch (error) {
    console.error('[NotificationPreferences] Failed to hydrate defaults:', error);
  }
}

module.exports = hydrateNotificationPreferences;
