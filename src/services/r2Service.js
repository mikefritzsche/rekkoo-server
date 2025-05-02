const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const crypto = require('crypto'); // For generating unique keys

// Ensure required environment variables are set
if (!process.env.R2_ENDPOINT || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY || !process.env.R2_BUCKET_NAME) {
  console.error("Error: Missing required R2 environment variables (R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME).");
  // Optionally, throw an error or exit if critical config is missing
  // process.exit(1); 
}

const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;

// Configure the S3 client for Cloudflare R2
const s3Client = new S3Client({
  region: "auto", // R2 doesn't use regions in the same way as AWS S3
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

console.log(`[R2 Service] Initialized S3 client for bucket: ${R2_BUCKET_NAME}`);

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
    const presignedUrl = await getSignedUrl(s3Client, command, { expiresIn });
    console.log(`[R2 Service] Successfully generated presigned URL valid for ${expiresIn} seconds.`);
    return { presignedUrl, key };
  } catch (error) {
    console.error("[R2 Service] Error generating presigned URL:", error);
    throw new Error("Could not generate upload URL.");
  }
};

module.exports = {
  generatePresignedPutUrl,
  s3Client // Export client if needed elsewhere (e.g., for delete operations)
}; 