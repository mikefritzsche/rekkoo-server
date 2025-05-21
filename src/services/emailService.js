const Mailjet = require('node-mailjet');

// Load environment variables
require('dotenv').config({ path: require('path').resolve(__dirname, '../../../.env.common') }); // Adjust path as needed

const mailjet = Mailjet.apiConnect(
  process.env.MJ_APIKEY_PUBLIC,
  process.env.MJ_APIKEY_PRIVATE
);

if (!process.env.MJ_APIKEY_PUBLIC || !process.env.MJ_APIKEY_PRIVATE) {
  console.error('MAILJET ERROR: API Keys not found in environment variables. Email functionality disabled.');
  // Optionally throw an error or use a mock client for development
}

// Helper function to get appropriate base URL for the current environment
const getAppBaseUrl = () => {
  const nodeEnv = process.env.NODE_ENV || 'development';
  
  if (nodeEnv === 'production') {
    return 'https://api.rekkoo.com';
  } else {
    return process.env.APP_BASE_URL || 'http://localhost:8081'; // Fallback for local dev
  }
};

const sendPasswordResetEmail = async (toEmail, resetToken) => {
  // Ensure API keys are available before attempting to send
  if (!process.env.MJ_APIKEY_PUBLIC || !process.env.MJ_APIKEY_PRIVATE) {
    console.error('Mailjet keys missing, cannot send password reset email.');
    throw new Error('Email configuration error.'); // Prevent proceeding
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
            "Email": "mike@mikefritzsche.com", // <-- IMPORTANT: Replace with your verified Mailjet sender email
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
  // Ensure API keys are available before attempting to send
  if (!process.env.MJ_APIKEY_PUBLIC || !process.env.MJ_APIKEY_PRIVATE) {
    console.error('Mailjet keys missing, cannot send verification email.');
    throw new Error('Email configuration error.'); // Prevent proceeding
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
            "Email": "mike@mikefritzsche.com", // Should be same as password reset
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

module.exports = {
  sendPasswordResetEmail,
  sendVerificationEmail
}; 