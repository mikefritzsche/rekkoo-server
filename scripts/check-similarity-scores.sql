-- Script to check similarity scores between users with preference embeddings
-- This will show all users with embeddings and their similarity scores

-- Check users with embeddings
SELECT
  e.entity_id as user_id,
  u.username,
  u.full_name,
  vector_dimension(e.embedding) as dimensions,
  e.created_at as embedding_created,
  e.updated_at as embedding_updated
FROM embeddings e
JOIN users u ON u.id = e.entity_id
WHERE e.entity_type = 'user_preferences'
ORDER BY e.updated_at DESC;

-- Check pairwise similarities between ALL users with embeddings
WITH user_embeddings AS (
  SELECT
    e.entity_id,
    e.embedding,
    u.username,
    u.full_name
  FROM embeddings e
  JOIN users u ON u.id = e.entity_id
  WHERE e.entity_type = 'user_preferences'
)
SELECT
  ue1.username as user1,
  ue2.username as user2,
  1 - (ue1.embedding <=> ue2.embedding) as similarity,
  ROUND((1 - (ue1.embedding <=> ue2.embedding)) * 100, 2) as similarity_percent
FROM user_embeddings ue1
CROSS JOIN user_embeddings ue2
WHERE ue1.entity_id < ue2.entity_id  -- Avoid duplicates and self-comparison
ORDER BY similarity DESC;

-- Check if any users have identical embeddings (100% similarity)
WITH user_embeddings AS (
  SELECT
    e.entity_id,
    e.embedding,
    u.username
  FROM embeddings e
  JOIN users u ON u.id = e.entity_id
  WHERE e.entity_type = 'user_preferences'
)
SELECT
  ue1.username as user1,
  ue2.username as user2,
  1 - (ue1.embedding <=> ue2.embedding) as similarity
FROM user_embeddings ue1
CROSS JOIN user_embeddings ue2
WHERE ue1.entity_id < ue2.entity_id
  AND (1 - (ue1.embedding <=> ue2.embedding)) > 0.99;  -- Nearly identical (>99%)