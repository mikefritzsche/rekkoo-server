const r2Service = require('../services/r2Service');

/**
 * Controller method to handle requests for a presigned PUT URL for R2.
 */
const getPresignedUploadUrl = async (req, res) => {
  // Assuming authentication middleware adds user info to req.user
  const userId = req.user?.id;
  const { contentType } = req.body; // Expecting client to send { contentType: 'image/jpeg' }

  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized. User ID not found.' });
  }

  if (!contentType) {
    return res.status(400).json({ error: 'Bad Request. ContentType is required in the request body.' });
  }

  console.log(`[Upload Controller] Received request for presigned URL from user ${userId} for type ${contentType}`);

  try {
    // Specify desired expiry time in seconds (e.g., 5 minutes)
    const expiresIn = 300; 
    const { presignedUrl, key } = await r2Service.generatePresignedPutUrl(userId, contentType, expiresIn);
    
    console.log(`[Upload Controller] Sending presigned URL and key back to client.`);
    res.status(200).json({ 
      presignedUrl,
      key, 
      // Optionally, return the public URL if your bucket is configured for public access 
      // and you want the client to know it immediately.
      // publicUrl: `https://YOUR_R2_PUBLIC_BUCKET_URL/${key}` 
    });

  } catch (error) {
    console.error("[Upload Controller] Error getting presigned URL:", error.message);
    res.status(500).json({ error: 'Failed to generate upload URL.', details: error.message });
  }
};

module.exports = {
  getPresignedUploadUrl,
}; 