    // server/src/routes/uploadRoutes.js (or wherever your endpoint is)
    const express = require('express');
    const { v4: uuidv4 } = require('uuid');
    const mime = require('mime-types');
    const multer = require('multer'); // Import multer
    const { authenticateJWT } = require('../auth/middleware'); // Use authenticateJWT

    // Import the new controller
    const uploadController = require('../controllers/uploadController');
    // Import the r2Service ONLY if needed for the server-mediated upload (it likely is)
    const { s3Client, generatePresignedPutUrl, generateUniqueKey } = require('../services/r2Service');

    const router = express.Router();

    // --- Multer Configuration ---
    // Use memory storage for simplicity. For large files, consider disk storage.
    const storage = multer.memoryStorage(); 
    const upload = multer({ 
        storage: storage,
        limits: { fileSize: 25 * 1024 * 1024 }, // Example: 25MB limit
        fileFilter: (req, file, cb) => {
            // Example filter: Accept only common image types
            if (file.mimetype.startsWith('image/')) {
                cb(null, true);
            } else {
                cb(new Error('Invalid file type, only images are allowed!'), false);
            }
        }
    });

    // --- NEW Endpoint for Pre-signed URL using Controller ---
    router.post('/presigned-url', authenticateJWT, uploadController.getPresignedUploadUrl);

    // --- NEW Endpoint for Server-Mediated Upload ---
    // Use the more robust authenticateJWT middleware
    router.post('/r2/', authenticateJWT, upload.single('file'), async (req, res) => {
        // 'file' is the field name expected from the client's FormData
        
        // Ensure user is authenticated (check added after middleware)
        if (!req.user || !req.user.id) {
             console.error('[Server Upload] User not found on request after authentication middleware.');
             return res.status(401).json({ error: 'Authentication required.' });
        }
        const userId = req.user.id; // Get user ID from authenticated request

        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded.' });
        }

        // Use file info provided by multer
        const fileBuffer = req.file.buffer;
        const contentType = req.file.mimetype;
        const originalName = req.file.originalname; // Can be used for naming if desired
        
        // Use the imported service function to generate the key
        const uniqueKey = generateUniqueKey(userId, contentType);

        console.log(`[Server Upload] Attempting to upload for user ${userId}. Key: ${uniqueKey}, ContentType: ${contentType}, Size: ${fileBuffer.length}`);

        const command = new PutObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME, // Use env var directly or from r2Service config
            Key: uniqueKey,
            Body: fileBuffer,
            ContentType: contentType,
        });

        try {
            // Use the imported s3Client from r2Service
            await s3Client.send(command);
            console.log(`[Server Upload] Successfully uploaded ${uniqueKey} to R2 bucket ${process.env.R2_BUCKET_NAME}.`);
            
            res.json({ 
                key: uniqueKey, 
            });

        } catch (error) {
            console.error('[Server Upload] Error uploading to R2:', error);
            res.status(500).json({ error: 'Could not upload file to storage.', details: error.message });
        }
    });

    // --- Endpoint/Mechanism to handle completion ---
    // The logic for handling completion (Client notification or R2 event handling via Workers)
    // remains conceptually the same. When the upload is confirmed, your server finds the
    // record and updates it with the *final, publicly accessible URL* based on the object `key`.
    // How you construct that final URL depends on whether you use R2's public bucket URL,
    // a custom domain, or serve it through Cloudflare Workers or your own backend proxy.

    module.exports = router;