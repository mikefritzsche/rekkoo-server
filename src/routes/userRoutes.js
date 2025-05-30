const express = require('express');
const authMiddleware = require('../middleware/authMiddleware'); // Assuming you have auth middleware

// This function will be called in index.js with the initialized userController
const createUserRouter = (userController) => {
  const router = express.Router();

  // GET /v1.0/users/suggestions - Get users to suggest following
  // Temporarily remove authMiddleware for testing this specific route
  router.get('/suggestions', userController.getUserSuggestions);

  // User profile routes (examples, ensure controller has these methods)
  // router.get('/:userId', authMiddleware, userController.getUserById);
  // router.put('/:userId', authMiddleware, userController.updateUser);

  // Follower/Following routes
  // GET /v1.0/users/:userId/followers - Get users following :userId
  router.get('/:userId/followers', authMiddleware, userController.getUserFollowers);

  // GET /v1.0/users/:userId/following - Get users :userId is following
  router.get('/:userId/following', authMiddleware, userController.getUserFollowing);

  // User Lists routes
  // GET /v1.0/users/:targetUserId/lists - Get public lists of :targetUserId
  router.get('/:targetUserId/lists', authMiddleware, userController.getUserPublicLists);

  // Example route for getting all users (if it exists on controller)
  router.get('/', authMiddleware, userController.getUsers); 

  // Note: Routes like createUser are typically in authRoutes.js or similar
  // router.post('/', userController.createUser);

  return router;
};

module.exports = createUserRouter; 