    // server/src/routes/uploadRoutes.js (or wherever your endpoint is)
    const express = require('express');
    const { v4: uuidv4 } = require('uuid');
    const mime = require('mime-types');
    const multer = require('multer'); // Import multer
    const { authenticateJWT } = require('../auth/middleware'); // Use authenticateJWT

    // Import the new controller
    const uploadController = require('../controllers/UploadController');
    // Import the r2Service ONLY if needed for the server-mediated upload (it likely is)
    const { s3Client, generatePresignedPutUrl, generateUniqueKey } = require('../services/r2Service');

    /**
     * Creates and returns a router with upload routes
     * @param {Object} uploadController - Controller with upload handling methods
     * @returns {express.Router} Express router
     */
    function createUploadRouter(uploadController) {
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

        /**
         * @route POST /presigned-url
         * @desc Generate a pre-signed URL for client-side file uploads
         * @access Private
         */
        router.post('/presigned-url', authenticateJWT, uploadController.getPresignedUploadUrl);

        /**
         * @route POST /r2
         * @desc Handle server-mediated file uploads
         * @access Private
         */
        router.post('/r2', authenticateJWT, upload.single('file'), uploadController.uploadFile);

        return router;
    }

    module.exports = createUploadRouter;