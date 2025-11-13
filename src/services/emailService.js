const Mailjet = require('node-mailjet');

// Load environment variables
require('dotenv').config({ path: require('path').resolve(__dirname, '../../../.env.common') });

const FROM_EMAIL = 'support@rekkoo.com';
const FROM_NAME = 'Rekkoo Support';

const MAILJET_ENABLED = !!process.env.MJ_APIKEY_PUBLIC && !!process.env.MJ_APIKEY_PRIVATE;

let mailjet = null;
if (MAILJET_ENABLED) {
  mailjet = Mailjet.apiConnect(
    process.env.MJ_APIKEY_PUBLIC,
    process.env.MJ_APIKEY_PRIVATE
  );
} else {
  console.warn('[emailService] Mailjet API keys missing – e-mails disabled in this environment.');
}

// Helper function to get appropriate base URL for the current environment
const getAppBaseUrl = () => {
  const nodeEnv = process.env.NODE_ENV || 'development';
  
  if (nodeEnv === 'production') {
    return 'https://app.rekkoo.com';
  } else {
    return process.env.APP_BASE_URL || 'http://localhost:8081'; // Fallback for local dev
  }
};

const sendPasswordResetEmail = async (toEmail, resetToken) => {
  if (!MAILJET_ENABLED) {
    console.info('[emailService] sendPasswordResetEmail skipped (mail disabled).');
    return { disabled: true };
  }

  // Construct the reset link using the environment-aware base URL
  const appBaseUrl = getAppBaseUrl();
  const resetLink = `${appBaseUrl}/reset-password?token=${resetToken}`;

  console.log(`Sending password reset email to: ${toEmail}`); // Log recipient

  const request = mailjet
    .post("send", { 'version': 'v3.1' })
    .request({
      "Messages": [
        {
          "From": {
            "Email": FROM_EMAIL,
            "Name": "Rekkoo App" // <-- Optional: Sender name
          },
          "To": [
            {
              "Email": toEmail,
              // "Name": "Recipient Name" // Optional
            }
          ],
          "Subject": "Reset Your Rekkoo Password",
          "TextPart": `Hi there,\n\nPlease reset your password by clicking the following link: ${resetLink}\n\nIf you didn't request this, please ignore this email.\n\nThanks,\nThe Rekkoo Team`,
          "HTMLPart": `<h3>Hi there,</h3><p>Please reset your password by clicking the following link:</p><p><a href="${resetLink}">${resetLink}</a></p><p>If you didn't request this, please ignore this email.</p><p>Thanks,<br/>The Rekkoo Team</p>`
          // "TemplateID": YOUR_TEMPLATE_ID, // Optional: Use a Mailjet template
          // "TemplateLanguage": true,
          // "Variables": {
          //   "reset_link": resetLink
          // }
        }
      ]
    });

  try {
    const result = await request;
    console.log('Mailjet send result:', JSON.stringify(result.body, null, 2));
    // Check result status if needed, Mailjet API v3.1 usually throws on error
    return result.body;
  } catch (err) {
    console.error('Mailjet send error:', err.statusCode, err.message, err.response?.body);
    throw new Error('Failed to send password reset email.'); // Re-throw a generic error
  }
};

const sendVerificationEmail = async (toEmail, username, verificationToken) => {
  if (!MAILJET_ENABLED) {
    console.info('[emailService] sendVerificationEmail skipped (mail disabled).');
    return { disabled: true };
  }

  // Construct the verification link using the environment-aware base URL
  const appBaseUrl = getAppBaseUrl();
  const verificationLink = `${appBaseUrl}/verify-email?token=${verificationToken}`;

  console.log(`Sending verification email to: ${toEmail}`); // Log recipient

  const request = mailjet
    .post("send", { 'version': 'v3.1' })
    .request({
      "Messages": [
        {
          "From": {
            "Email": FROM_EMAIL, // Should be same as password reset
            "Name": "Rekkoo App"
          },
          "To": [
            {
              "Email": toEmail
            }
          ],
          "Subject": "Verify Your Rekkoo Account",
          "TextPart": `Hi ${username},\n\nWelcome to Rekkoo! Please verify your email by clicking the following link: ${verificationLink}\n\nThis link will expire in 24 hours.\n\nThanks,\nThe Rekkoo Team`,
          "HTMLPart": `<h3>Hi ${username},</h3><p>Welcome to Rekkoo!</p><p>Please verify your email by clicking the following link:</p><p><a href="${verificationLink}">${verificationLink}</a></p><p>This link will expire in 24 hours.</p><p>Thanks,<br/>The Rekkoo Team</p>`
        }
      ]
    });

  try {
    const result = await request;
    console.log('Verification email sent successfully');
    return result.body;
  } catch (err) {
    console.error('Mailjet send error:', err.statusCode, err.message, err.response?.body);
    throw new Error('Failed to send verification email.'); // Re-throw a generic error
  }
};

const sendInvitationEmail = async (toEmail, invitationToken, invitationCode, inviter, metadata = {}) => {
  if (!MAILJET_ENABLED) {
    console.info('[emailService] sendInvitationEmail skipped (mail disabled).');
    return { disabled: true };
  }

  // Construct the invitation link using the environment-aware base URL
  const appBaseUrl = getAppBaseUrl();
  const invitationLink = `${appBaseUrl}/register?code=${encodeURIComponent(invitationCode)}`;
  const customMessage = metadata.message || '';

  console.log(`Sending invitation email to: ${toEmail}`); // Log recipient

  const request = mailjet
    .post("send", { 'version': 'v3.1' })
    .request({
      "Messages": [
        {
          "From": {
            "Email": FROM_EMAIL,
            "Name": "Rekkoo App"
          },
          "To": [
            {
              "Email": toEmail
            }
          ],
          "Subject": `${inviter.username} invited you to join Rekkoo!`,
          "TextPart": `Hi there,\n\n${inviter.username} has invited you to join Rekkoo!\n\n${customMessage ? `Personal message: "${customMessage}"\n\n` : ''}You can accept this invitation by:\n\n1. Clicking this link: ${invitationLink}\n2. Or using invitation code: ${invitationCode}\n\nThis invitation will expire in 7 days.\n\nThanks,\nThe Rekkoo Team`,
          "HTMLPart": `<h3>Hi there,</h3><p><strong>${inviter.username}</strong> has invited you to join Rekkoo!</p>${customMessage ? `<p><em>Personal message:</em> "${customMessage}"</p>` : ''}<p>You can accept this invitation by:</p><ol><li>Clicking this link: <a href="${invitationLink}">${invitationLink}</a></li><li>Or using invitation code: <strong>${invitationCode}</strong></li></ol><p>This invitation will expire in 7 days.</p><p>Thanks,<br/>The Rekkoo Team</p>`
        }
      ]
    });

  try {
    const result = await request;
    console.log('Invitation email sent successfully');
    return result.body;
  } catch (err) {
    console.error('Mailjet send error:', err.statusCode, err.message, err.response?.body);
    throw new Error('Failed to send invitation email.'); // Re-throw a generic error
  }
};

const sendSupportEmail = async ({ fromEmail, fromName, subject, message, metadata = {} }) => {
  if (!MAILJET_ENABLED) {
    console.info('[emailService] sendSupportEmail skipped (mail disabled).');
    return { disabled: true };
  }

  const supportEmail = process.env.SUPPORT_EMAIL || 'support@rekkoo.com';
  const safeSubject = subject?.trim() || `Support request from ${fromEmail}`;
  const safeMessage = message?.trim() || '(no message provided)';
  const metaString = Object.keys(metadata || {}).length
    ? `<pre>${JSON.stringify(metadata, null, 2)}</pre>`
    : '';

  const request = mailjet
    .post('send', { version: 'v3.1' })
    .request({
      Messages: [
        {
          From: {
            Email: 'support@rekkoo.com',
            Name: 'Rekkoo Support',
          },
          To: [
            {
              Email: supportEmail,
            },
          ],
          Subject: safeSubject,
          ReplyTo: {
            Email: fromEmail,
            Name: fromName || fromEmail,
          },
          TextPart: `Support request from ${fromName || fromEmail}\n\n${safeMessage}\n\nMetadata:\n${JSON.stringify(
            metadata,
            null,
            2,
          )}`,
          HTMLPart: `<h3>Support request</h3>
            <p><strong>From:</strong> ${fromName || fromEmail} &lt;${fromEmail}&gt;</p>
            <p><strong>Subject:</strong> ${safeSubject}</p>
            <p>${safeMessage.replace(/\n/g, '<br/>')}</p>
            ${metaString}`,
        },
      ],
    });

  try {
    const result = await request;
    return result.body;
  } catch (err) {
    console.error('Mailjet sendSupportEmail error:', err.statusCode, err.message, err.response?.body);
    throw new Error('Failed to send support email.');
  }
};

module.exports = {
  sendPasswordResetEmail,
  sendVerificationEmail,
  sendInvitationEmail,
  sendSupportEmail,
};
