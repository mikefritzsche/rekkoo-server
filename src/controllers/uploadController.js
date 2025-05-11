const { generatePresignedPutUrl, generateUniqueKey } = require('../services/r2Service'); // Assuming r2Service is in ../services/

const getPresignedUploadUrl = async (req, res) => {
  const userId = req.user?.id; // From authenticateJWT middleware
  const { fileName, contentType } = req.body; // Expect fileName and contentType from client

  if (!userId) {
    return res.status(401).json({ error: 'User not authenticated' });
  }

  if (!fileName || !contentType) {
    return res.status(400).json({ error: 'Missing fileName or contentType in request body' });
  }

  try {
    // Generate a unique key for the object in R2
    // The key might include userId to namespace files or use the original fileName if appropriate and sanitized
    const key = generateUniqueKey(userId, contentType, fileName);

    const presignedUrl = await generatePresignedPutUrl(key, contentType);

    res.status(200).json({
      presignedUrl,
      key, // Send the key back so client knows where the file will be stored
      method: 'PUT', // Client should use PUT request
      // You might also want to send back the public URL if it's predictable
      // publicUrl: `https://your-r2-public-url/${key}` 
    });
  } catch (error) {
    console.error('[UploadController] Error generating pre-signed URL:', error);
    res.status(500).json({ error: 'Could not generate pre-signed URL', details: error.message });
  }
};

module.exports = {
  getPresignedUploadUrl,
}; 