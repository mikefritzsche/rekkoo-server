const DEFAULT_NOTIFICATION_PREFERENCES = Object.freeze({
  email_notifications: true,
  emailInvitations: true,
  channels: {
    push: true,
    email: true,
  },
  marketing: {
    newsletters: false,
    productUpdates: true,
    promotions: false,
  },
});

const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

const normalizeNotificationPreferences = (preferences) => {
  const base = isObject(preferences) ? preferences : {};

  const merged = {
    ...DEFAULT_NOTIFICATION_PREFERENCES,
    ...base,
    channels: {
      ...DEFAULT_NOTIFICATION_PREFERENCES.channels,
      ...(isObject(base.channels) ? base.channels : {}),
    },
    marketing: {
      ...DEFAULT_NOTIFICATION_PREFERENCES.marketing,
      ...(isObject(base.marketing) ? base.marketing : {}),
    },
  };

  const needsHydration =
    !isObject(preferences) ||
    Object.keys(base).length === 0 ||
    typeof base.email_notifications !== 'boolean' ||
    typeof base.emailInvitations !== 'boolean' ||
    !isObject(base.channels) ||
    typeof base.channels.email !== 'boolean' ||
    typeof base.channels.push !== 'boolean' ||
    !isObject(base.marketing) ||
    typeof base.marketing.newsletters !== 'boolean' ||
    typeof base.marketing.productUpdates !== 'boolean' ||
    typeof base.marketing.promotions !== 'boolean';

  return {
    value: merged,
    needsHydration,
  };
};

module.exports = {
  DEFAULT_NOTIFICATION_PREFERENCES,
  normalizeNotificationPreferences,
};
