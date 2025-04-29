    // server/src/routes/uploadRoutes.js (or wherever your endpoint is)
    const express = require('express');
    const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
    const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
    const { v4: uuidv4 } = require('uuid');

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

    // Endpoint to get a pre-signed URL
    router.post('/presigned-url', async (req, res) => {
        const { filename, contentType } = req.body;

        if (!filename || !contentType) {
            return res.status(400).json({ error: 'Missing filename or contentType' });
        }

        const extension = filename.split('.').pop();
        // Make sure key doesn't start with /
        const uniqueKey = `user-uploads/${uuidv4()}${extension ? '.' + extension : ''}`.replace(/^\//, '');


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

    // --- Endpoint/Mechanism to handle completion ---
    // The logic for handling completion (Client notification or R2 event handling via Workers)
    // remains conceptually the same. When the upload is confirmed, your server finds the
    // record and updates it with the *final, publicly accessible URL* based on the object `key`.
    // How you construct that final URL depends on whether you use R2's public bucket URL,
    // a custom domain, or serve it through Cloudflare Workers or your own backend proxy.

    module.exports = router;