const { generatePresignedPutUrl, generateUniqueKey, isR2Configured } = require('../services/r2Service');
const { PutObjectCommand } = require('@aws-sdk/client-s3');

/**
 * Factory function that creates an UploadController
 * @param {Object} socketService - Optional socket service for real-time updates
 * @returns {Object} Controller object with upload handling methods
 */
function uploadControllerFactory(socketService = null) {
  // Create a dummy socket service if none is provided
  const safeSocketService = socketService || {
    emitToUser: () => {} // No-op function
  };

  /**
   * Generate a pre-signed URL for client-side file uploads
   */
  const getPresignedUploadUrl = async (req, res) => {
    // Check if R2 is configured
    if (!isR2Configured()) {
      return res.status(503).json({ 
        error: 'File upload service is currently unavailable', 
        details: 'R2 storage is not configured' 
      });
    }

    const userId = req.user?.id; // From authenticateJWT middleware
    const { fileName, contentType, folder } = req.body; // Expect optional folder from client

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    if (!fileName || !contentType) {
      return res.status(400).json({ error: 'Missing fileName or contentType in request body' });
    }

    try {
      // Generate presigned URL using the service
      const { presignedUrl, key } = await generatePresignedPutUrl(userId, contentType, 300, folder);

      res.status(200).json({
        presignedUrl,
        key, // Send the key back so client knows where the file will be stored
        method: 'PUT', // Client should use PUT request
      });
    } catch (error) {
      console.error('[UploadController] Error generating pre-signed URL:', error);
      res.status(500).json({ error: 'Could not generate pre-signed URL', details: error.message });
    }
  };

  /**
   * Handle server-mediated file uploads
   */
  const uploadFile = async (req, res) => {
    // Check if R2 is configured
    if (!isR2Configured()) {
      return res.status(503).json({ 
        error: 'File upload service is currently unavailable', 
        details: 'R2 storage is not configured' 
      });
    }

    // Ensure user is authenticated
    if (!req.user || !req.user.id) {
      console.error('[Server Upload] User not found on request after authentication middleware.');
      return res.status(401).json({ error: 'Authentication required.' });
    }
    const userId = req.user.id; // Get user ID from authenticated request

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded.' });
    }

    // Optional folder for organisation
    const folder = req.body?.folder;

    // Use file info provided by multer
    const fileBuffer = req.file.buffer;
    const contentType = req.file.mimetype;
    const originalName = req.file.originalname; // Can be used for naming if desired

    // Use the imported service function to generate the key, including folder if provided
    const uniqueKey = generateUniqueKey(userId, contentType, folder);

    console.log(`[Server Upload] Attempting to upload for user ${userId}. Key: ${uniqueKey}, ContentType: ${contentType}, Size: ${fileBuffer.length}`);

    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: uniqueKey,
      Body: fileBuffer,
      ContentType: contentType,
    });

    try {
      // Lazy load s3Client to avoid requiring it when R2 is not configured
      const { s3Client } = require('../services/r2Service');
      const client = s3Client;
      await client.send(command);
      console.log(`[Server Upload] Successfully uploaded ${uniqueKey} to R2 bucket ${process.env.R2_BUCKET_NAME}.`);
      
      const publicBase = process.env.R2_PUBLIC_URL_BASE;
      const publicUrl = publicBase ? `${publicBase}/${uniqueKey}` : undefined;
      res.json({ 
        key: uniqueKey,
        url: publicUrl,
      });

    } catch (error) {
      console.error('[Server Upload] Error uploading to R2:', error);
      res.status(500).json({ error: 'Could not upload file to storage.', details: error.message });
    }
  };

  /**
   * Delete an existing file from R2 under the authenticated user's namespace.
   * Path param :key may contain slashes – comes from router wildcard.
   */
  const deleteFile = async (req, res) => {
    if (!isR2Configured()) {
      return res.status(503).json({
        error: 'File upload service is currently unavailable',
        details: 'R2 storage is not configured'
      });
    }

    if (!req.user || !req.user.id) {
      return res.status(401).json({ error: 'Authentication required.' });
    }

    const userId = req.user.id;
    // Express wildcard param includes the entire remainder of path
    const objectKey = req.params.key;

    if (!objectKey) {
      return res.status(400).json({ error: 'Object key is required.' });
    }

    // Basic safety: ensure the key belongs to this user
    const expectedPrefix = `user-uploads/user-${userId}/`;
    if (!objectKey.startsWith(expectedPrefix)) {
      return res.status(403).json({ error: 'Not authorized to delete this object.' });
    }

    try {
      const { deleteR2Object } = require('../services/r2Service');
      await deleteR2Object(objectKey);
      return res.json({ success: true, key: objectKey });
    } catch (err) {
      console.error('[UploadController] Error deleting R2 object:', err);
      return res.status(500).json({ error: 'Failed to delete object.', details: err.message });
    }
  };

  // Return all controller methods
  return {
    getPresignedUploadUrl,
    uploadFile,
    deleteFile,
  };
}

module.exports = uploadControllerFactory; 