    // server/src/routes/uploadRoutes.js (or wherever your endpoint is)
    const express = require('express');
    const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
    const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
    const { v4: uuidv4 } = require('uuid');
    const mime = require('mime-types');
    const multer = require('multer'); // Import multer
    // Placeholder for your actual authentication middleware
    const { authenticateJWT } = require('../auth/middleware'); // Use authenticateJWT

    const router = express.Router();

    // --- START R2 Configuration ---
    const ACCOUNT_ID = process.env.R2_ACCOUNT_ID; // Make sure to add this to .env if using endpoint URL construction below
    const ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
    const SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
    const BUCKET_NAME = process.env.R2_BUCKET_NAME;
    const ENDPOINT = process.env.R2_ENDPOINT; // Should be like https://<ACCOUNT_ID>.r2.cloudflarestorage.com
    const REGION = process.env.R2_REGION || 'auto'; // Default to 'auto' for R2

    if (!ENDPOINT || !ACCESS_KEY_ID || !SECRET_ACCESS_KEY || !BUCKET_NAME) {
        console.error("Missing Cloudflare R2 environment variables!");
        // Potentially throw an error or disable the endpoint
    }

    // Configure S3 Client for Cloudflare R2
    const s3Client = new S3Client({
        endpoint: ENDPOINT,
        region: REGION, // R2 needs a region specified, 'auto' works
        credentials: {
            accessKeyId: ACCESS_KEY_ID,
            secretAccessKey: SECRET_ACCESS_KEY,
        },
    });
    // --- END R2 Configuration ---

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


    // --- END Multer Configuration ---

    // --- Endpoint for Pre-signed URL (Client-side upload) ---
    // Keep this for now, maybe useful later or for other upload types
    router.post('/presigned-url', async (req, res) => {
        const { filename, contentType } = req.body;

        if (!filename || !contentType) {
            return res.status(400).json({ error: 'Missing filename or contentType' });
        }

        // Use mime-types to get the correct extension
        const extension = mime.extension(contentType);
        if (!extension) {
            console.warn(`Could not determine extension for contentType: ${contentType}. Using default.`);
            // Optionally fallback to a default or reject if extension is critical
        }

        // Construct the key with the proper extension
        const uniqueKey = `user-uploads/${uuidv4()}${extension ? '.' + extension : ''}`.replace(/^\//, '');

        console.log(`Generating presigned URL for Key: ${uniqueKey}, ContentType: ${contentType}`); // Log generated key

        const command = new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: uniqueKey,
            ContentType: contentType,
            // You generally don't set ACLs like 'public-read' directly on R2 uploads
            // Access is controlled via bucket settings or Cloudflare Access/Workers
        });

        try {
            const signedUrl = await getSignedUrl(s3Client, command, {
                expiresIn: 300, // 5 minutes
                // Explicitly sign host, content-type, and x-amz-content-sha256
                signableHeaders: new Set(['host', 'content-type', 'x-amz-content-sha256']),
            });

            console.log(`Generated R2 pre-signed URL for key: ${uniqueKey}`);

             // Construct the final *readable* URL. This depends on how you expose your bucket:
             // Option 1: Public Bucket URL (if enabled & desired - simpler but less secure)
             // const finalImageUrl = `https://pub-<YOUR_BUCKET_PUBLIC_ID>.r2.dev/${uniqueKey}`;
             // Option 2: Custom Domain connected to R2
             // const finalImageUrl = `https://your-r2-custom-domain.com/${uniqueKey}`;
             // Option 3: Serve via Worker/App (More secure, recommended) - URL determined by your app logic
             // For now, we only return the key, the server should construct the final URL when confirming upload.
            const finalImageUrl = `${process.env.R2_PUBLIC_URL_BASE || 'YOUR_APP_BASE_URL/r2'}/${uniqueKey}`; // Placeholder

            res.json({
                uploadUrl: signedUrl,
                key: uniqueKey,
                // It's often better for the *server* to construct the final URL later
                // when confirming the upload, rather than the client guessing it.
                // finalImageUrl: finalImageUrl // Example final URL
            });
        } catch (error) {
            console.error('Error generating R2 pre-signed URL:', error);
            res.status(500).json({ error: 'Could not generate upload URL' });
        }
    });

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
        
        // Generate a unique key for R2 including the user ID
        const extension = mime.extension(contentType);
        const uniqueKey = `user-uploads/${userId}/${uuidv4()}${extension ? '.' + extension : ''}`.replace(/^\//, ''); // Add userId to path

        console.log(`[Server Upload] Attempting to upload for user ${userId}. Key: ${uniqueKey}, ContentType: ${contentType}, Size: ${fileBuffer.length}`);

        const command = new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: uniqueKey,
            Body: fileBuffer, // The file buffer from multer
            ContentType: contentType,
        });

        try {
            await s3Client.send(command);
            console.log(`[Server Upload] Successfully uploaded ${uniqueKey} to R2 bucket ${BUCKET_NAME}.`);
            
            // Return the key to the client
            res.json({ 
                key: uniqueKey, 
                // Optionally construct and return the final URL if needed immediately
                // finalImageUrl: `${process.env.R2_PUBLIC_URL_BASE || 'YOUR_APP_BASE_URL/r2'}/${uniqueKey}` 
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