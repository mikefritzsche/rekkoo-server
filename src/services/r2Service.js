const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const crypto = require('crypto'); // For generating unique keys

// Check if R2 configuration is available
const isR2Configured = () => {
  return !!(process.env.R2_ENDPOINT && 
           process.env.R2_ACCESS_KEY_ID && 
           process.env.R2_SECRET_ACCESS_KEY && 
           process.env.R2_BUCKET_NAME);
};

const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;

// Initialize S3 client only if configuration is available
let s3Client = null;

const getS3Client = () => {
  if (!isR2Configured()) {
    throw new Error("R2 service is not configured. Missing required environment variables (R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME).");
  }
  
  if (!s3Client) {
    s3Client = new S3Client({
      region: "auto", // R2 doesn't use regions in the same way as AWS S3
      endpoint: process.env.R2_ENDPOINT,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    });
    console.log(`[R2 Service] Initialized S3 client for bucket: ${R2_BUCKET_NAME}`);
  }
  
  return s3Client;
};

// Log configuration status at startup
if (isR2Configured()) {
  console.log(`[R2 Service] R2 configuration found - file upload service available`);
} else {
  console.log(`[R2 Service] R2 configuration missing - file upload service disabled`);
}

/**
 * Generates a unique object key including user ID.
 * Example: user-uploads/user-123/timestamp-random.jpg
 * @param {string} userId - ID of the user uploading the file.
 * @param {string} mimeType - The MIME type of the file (e.g., 'image/jpeg').
 * @returns {string} A unique object key.
 */
const generateUniqueKey = (userId, mimeType) => {
  const randomBytes = crypto.randomBytes(16).toString('hex');
  const timestamp = Date.now();
  const fileExtension = mimeType.split('/')[1]?.toLowerCase() || 'bin'; // Ensure extension is lowercase
  // Use user-specific path
  return `user-uploads/user-${userId}/${timestamp}-${randomBytes}.${fileExtension}`;
  // return `uploads/${timestamp}-${randomBytes}.${fileExtension}`; // Old path
};

/**
 * Generates a presigned URL for uploading an object directly to R2.
 * @param {string} userId - The ID of the user requesting the upload. Needed for key generation.
 * @param {string} contentType - The expected Content-Type of the file being uploaded (e.g., 'image/jpeg').
 * @param {number} expiresIn - URL validity duration in seconds (default: 300).
 * @returns {Promise<{presignedUrl: string, key: string}>} An object containing the presigned URL and the generated object key.
 */
const generatePresignedPutUrl = async (userId, contentType, expiresIn = 300) => {
  if (!isR2Configured()) {
    throw new Error("R2 service is not configured. File upload is currently unavailable.");
  }
  
  if (!userId || !contentType) {
      throw new Error("User ID and Content Type are required to generate a presigned URL.");
  }

  const key = generateUniqueKey(userId, contentType);
  console.log(`[R2 Service] Generating presigned PUT URL for key: ${key}, contentType: ${contentType}`);

  const command = new PutObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
    ContentType: contentType, 
    // ACL: 'public-read', // Optional: Set if you want uploaded objects to be publicly readable by default
    // Metadata: { // Optional: Add custom metadata
    //   'x-amz-meta-user-id': userId 
    // }
  });

  try {
    const client = getS3Client();
    const presignedUrl = await getSignedUrl(client, command, { expiresIn });
    console.log(`[R2 Service] Successfully generated presigned URL valid for ${expiresIn} seconds.`);
    return { presignedUrl, key };
  } catch (error) {
    console.error("[R2 Service] Error generating presigned URL:", error);
    throw new Error("Could not generate upload URL.");
  }
};

module.exports = {
  generatePresignedPutUrl,
  generateUniqueKey,
  isR2Configured,
  get s3Client() {
    return getS3Client();
  }
}; 