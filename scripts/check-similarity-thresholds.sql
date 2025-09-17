-- Script to check similarity score distribution for a given user
-- Replace 'YOUR_USER_ID' with the actual user ID

WITH user_embedding AS (
  SELECT embedding
  FROM embeddings
  WHERE entity_type = 'user_preferences'
    AND entity_id = 'YOUR_USER_ID'  -- Replace with actual user ID
),
similarity_scores AS (
  SELECT
    e.entity_id as user_id,
    u.username,
    u.full_name,
    1 - (e.embedding <=> ue.embedding) as similarity
  FROM embeddings e
  CROSS JOIN user_embedding ue
  JOIN users u ON u.id = e.entity_id
  WHERE e.entity_type = 'user_preferences'
    AND e.entity_id != 'YOUR_USER_ID'  -- Replace with actual user ID
)
SELECT
  'Distribution' as metric,
  COUNT(*) FILTER (WHERE similarity > 0.8) as "Above 80%",
  COUNT(*) FILTER (WHERE similarity > 0.6 AND similarity <= 0.8) as "60-80%",
  COUNT(*) FILTER (WHERE similarity > 0.4 AND similarity <= 0.6) as "40-60%",
  COUNT(*) FILTER (WHERE similarity > 0.2 AND similarity <= 0.4) as "20-40%",
  COUNT(*) FILTER (WHERE similarity <= 0.2) as "Below 20%",
  COUNT(*) as "Total Users"
FROM similarity_scores

UNION ALL

SELECT
  'Thresholds' as metric,
  COUNT(*) FILTER (WHERE similarity > 0.4) as "Would show in Recommended (>40%)",
  NULL,
  NULL,
  NULL,
  NULL,
  COUNT(*) as "Total with embeddings"
FROM similarity_scores

UNION ALL

SELECT
  'Stats' as metric,
  ROUND(MIN(similarity)::numeric * 100, 1) as "Min %",
  ROUND(AVG(similarity)::numeric * 100, 1) as "Average %",
  ROUND(MAX(similarity)::numeric * 100, 1) as "Max %",
  NULL,
  NULL,
  NULL
FROM similarity_scores;

-- Also check how many users have preferences and embeddings
SELECT
  COUNT(DISTINCT up.user_id) as users_with_preferences,
  COUNT(DISTINCT e.entity_id) as users_with_embeddings,
  COUNT(DISTINCT u.id) as total_users
FROM users u
LEFT JOIN user_preferences up ON up.user_id = u.id
LEFT JOIN embeddings e ON e.entity_type = 'user_preferences' AND e.entity_id = u.id;