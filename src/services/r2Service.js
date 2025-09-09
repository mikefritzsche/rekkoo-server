const { S3Client, PutObjectCommand, ListObjectsV2Command, GetObjectCommand } = require("@aws-sdk/client-s3");
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
    return null; // Gracefully handle missing config so server can still start
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
 * Generates a unique object key including user ID and, optionally, a sub-folder
 * that represents the list type (e.g. "places", "movies").
 * Resulting path → user-uploads/user-{id}/[subFolder/]<timestamp>-<random>.ext
 * The optional folder is sanitised to allow only simple a–z characters to
 * protect against path-traversal or accidental nesting.
 *
 * @param {string} userId   User ID string
 * @param {string} mimeType Mime type (e.g. image/jpeg)
 * @param {string} [folder] Optional sub-folder name (list type)
 * @returns {string} The key path for the upload
 */
const generateUniqueKey = (userId, mimeType, folder) => {
  const randomBytes = crypto.randomBytes(16).toString('hex');
  const timestamp = Date.now();
  const fileExtension = mimeType.split('/')[1]?.toLowerCase() || 'bin';

  // Basic sanitisation – letters, numbers, dashes only
  let safeFolder = typeof folder === 'string' ? folder.trim().toLowerCase() : '';
  if (safeFolder && !/^[a-z0-9_-]+$/.test(safeFolder)) {
    // If invalid, discard to avoid security issues
    safeFolder = '';
  }

  const basePath = `user-uploads/user-${userId}`;
  const folderPath = safeFolder ? `/${safeFolder}` : '';

  return `${basePath}${folderPath}/${timestamp}-${randomBytes}.${fileExtension}`;
};

/**
 * Generates a presigned URL for uploading an object directly to R2.
 * @param {string} userId - The ID of the user requesting the upload. Needed for key generation.
 * @param {string} contentType - The expected Content-Type of the file being uploaded (e.g., 'image/jpeg').
 * @param {number} expiresIn - URL validity duration in seconds (default: 300).
 * @returns {Promise<{presignedUrl: string, key: string}>} An object containing the presigned URL and the generated object key.
 */
const generatePresignedPutUrl = async (userId, contentType, expiresIn = 300, folder) => {
  if (!isR2Configured()) {
    throw new Error("R2 service is not configured. File upload is currently unavailable.");
  }
  
  if (!userId || !contentType) {
      throw new Error("User ID and Content Type are required to generate a presigned URL.");
  }

  const key = generateUniqueKey(userId, contentType, folder);
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

/**
 * Deletes an object from the bucket.
 * @param {string} key Full object key (path inside bucket)
 */
const deleteR2Object = async (key) => {
  if (!isR2Configured()) {
    throw new Error('R2 not configured');
  }
  if (!key) {
    throw new Error('Key is required');
  }
  const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
  const client = getS3Client();
  const command = new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key });
  await client.send(command);
  console.log(`[R2 Service] Deleted object ${key}`);
};

/**
 * Lists objects in the R2 bucket with optional prefix and pagination
 * @param {Object} options - List options
 * @param {string} options.prefix - Optional prefix to filter objects
 * @param {string} options.continuationToken - For pagination
 * @param {number} options.maxKeys - Maximum number of keys to return (default: 100)
 * @returns {Promise<Object>} List response with objects and continuation token
 */
const listR2Objects = async ({ prefix = '', continuationToken = null, maxKeys = 100 } = {}) => {
  if (!isR2Configured()) {
    throw new Error('R2 service is not configured');
  }

  const client = getS3Client();
  const command = new ListObjectsV2Command({
    Bucket: R2_BUCKET_NAME,
    Prefix: prefix,
    MaxKeys: maxKeys,
    ContinuationToken: continuationToken,
  });

  try {
    const response = await client.send(command);
    console.log(`[R2 Service] Listed ${response.Contents?.length || 0} objects with prefix: ${prefix}`);
    
    // Process the response to include public URLs if configured
    const publicBase = process.env.R2_PUBLIC_URL_BASE;
    const contents = (response.Contents || []).map(item => ({
      ...item,
      PublicUrl: publicBase ? `${publicBase}/${item.Key}` : null,
    }));

    return {
      contents,
      isTruncated: response.IsTruncated,
      nextContinuationToken: response.NextContinuationToken,
      keyCount: response.KeyCount,
    };
  } catch (error) {
    console.error('[R2 Service] Error listing objects:', error);
    throw new Error('Could not list objects from storage');
  }
};

/**
 * Generates a presigned GET URL for viewing/downloading an object
 * @param {string} key - The object key
 * @param {number} expiresIn - URL validity duration in seconds (default: 3600)
 * @returns {Promise<string>} The presigned URL
 */
const generatePresignedGetUrl = async (key, expiresIn = 3600) => {
  if (!isR2Configured()) {
    throw new Error('R2 service is not configured');
  }

  if (!key) {
    throw new Error('Object key is required');
  }

  const client = getS3Client();
  const command = new GetObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
  });

  try {
    const presignedUrl = await getSignedUrl(client, command, { expiresIn });
    console.log(`[R2 Service] Generated presigned GET URL for key: ${key}`);
    return presignedUrl;
  } catch (error) {
    console.error('[R2 Service] Error generating presigned GET URL:', error);
    throw new Error('Could not generate download URL');
  }
};

module.exports = {
  generatePresignedPutUrl,
  generatePresignedGetUrl,
  generateUniqueKey,
  isR2Configured,
  deleteR2Object,
  listR2Objects,
  get s3Client() {
    return getS3Client();
  }
}; 