// src/routes/chat.routes.js
const express = require('express');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');
require('dotenv').config(); // Ensure environment variables are loaded

// Assuming tools.js is in the parent directory (src/) relative to routes/
const availableTools = require('../tools'); // Make sure this path is correct

// --- Export a function that takes socketService ---
module.exports = (socketService) => {
  const router = express.Router(); // Create router inside the function

  // --- Configuration ---
  // <<< Using the MODEL_NAME from your original example >>>
  const MODEL_NAME = "gemini-2.5-pro-exp-03-25"; // Your specified experimental model
  const API_KEY = process.env.GEMINI_API_KEY;

  if (!API_KEY) {
    console.error("FATAL ERROR: GEMINI_API_KEY environment variable not set.");
    // Optionally, you might throw an error or exit if the key is critical at startup
    // process.exit(1);
  }

  // --- Initialize Gemini Client ---
  const genAI = API_KEY ? new GoogleGenerativeAI(API_KEY) : null;

  // --- Define Tool Schemas for Gemini ---
  // IMPORTANT: Keep these schemas consistent with your actual tool functions
  const tools = [
    {
      functionDeclarations: [
        {
          name: "getCurrentWeather",
          description: "Get the current weather in a given location.",
          parameters: {
            type: "object",
            properties: {
              location: {
                type: "string",
                description: "The city and state, e.g., San Francisco, CA",
              },
              unit: { type: "string", enum: ["celsius", "fahrenheit"] },
            },
            required: ["location"],
          },
        },
        {
          name: "getStockPrice",
          description: "Get the current price for a specific stock ticker symbol.",
          parameters: {
            type: "object",
            properties: {
              tickerSymbol: {
                type: "string",
                description: "The stock ticker symbol, e.g., GOOGL for Google.",
              },
            },
            required: ["tickerSymbol"],
          },
        }
        // Add more function declarations here if needed
      ],
    },
  ];

  // --- Chat Endpoint Logic ---
  // POST /api/chat/
  router.post('/', async (req, res) => {
    if (!genAI) {
      console.error("Gemini client not initialized. Check API Key.");
      return res.status(500).json({ error: 'Server configuration error: Missing API Key.' });
    }

    // <<< Assume Authentication Middleware has run >>>
    // Replace 'req.user.id' with how you actually access the authenticated user's ID.
    const userId = req.user?.id; // Example: Get user ID from request (added by auth middleware)

    try {
      const { history } = req.body; // Expecting an array of { role: 'user'/'model', parts: [{ text: '...' }] }

      if (!history || !Array.isArray(history) || history.length === 0) {
        return res.status(400).json({ error: 'Invalid or empty history format provided.' });
      }
      const lastMessage = history[history.length - 1];
      if (!lastMessage || lastMessage.role !== 'user' || !lastMessage.parts || !lastMessage.parts[0]?.text) {
        return res.status(400).json({ error: 'Invalid format for the last user message.' });
      }

      const model = genAI.getGenerativeModel({
        model: MODEL_NAME, // Using your specified model
        tools: tools,
        safetySettings: [ // Optional: Adjust safety settings as needed
          { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
          { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
          { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
          { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
        ],
        // generationConfig: { /* ... */ },
      });

      const chat = model.startChat({
        history: history.slice(0, -1),
      });

      const latestUserMessageText = lastMessage.parts[0].text;

      console.log(`[${new Date().toISOString()}] User ${userId || 'UNKNOWN'} sending to Gemini (${MODEL_NAME}): "${latestUserMessageText.substring(0, 80)}..."`);
      let result = await chat.sendMessage(latestUserMessageText);
      let response = result.response;

      console.log(`[${new Date().toISOString()}] --- Initial Gemini Response ---`);
      // console.log(JSON.stringify(response, null, 2)); // Keep for debugging if needed

      // --- Function Calling Loop ---
      let functionCalls;
      do {
        functionCalls = null; // Reset for this iteration

        const currentFunctionCalls = response?.candidates?.[0]?.content?.parts
        ?.filter(part => !!part.functionCall)
        ?.map(part => part.functionCall);

        if (Array.isArray(currentFunctionCalls) && currentFunctionCalls.length > 0) {
          functionCalls = currentFunctionCalls; // Assign if found
          console.log(`[${new Date().toISOString()}] Gemini requested function call(s):`, functionCalls.map(fc => fc.name).join(', '));
          const functionResponses = []; // To store results for this round

          // Execute all function calls requested in this turn
          for (const functionCall of functionCalls) {
            const functionName = functionCall.name;
            const args = functionCall.args;

            if (availableTools[functionName]) {
              try {
                console.log(`[${new Date().toISOString()}] -> Executing tool for user ${userId || 'UNKNOWN'}: ${functionName} with args:`, args || {});
                const toolResult = await availableTools[functionName](args || {}); // Pass empty object if args undefined
                const stringResult = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult);

                // Ensure result is a string
                if (typeof stringResult !== 'string') {
                  console.error(`[${new Date().toISOString()}] !!! Tool ${functionName} result could not be converted to string.`);
                  functionResponses.push({
                    functionResponse: {
                      name: functionName,
                      response: { content: JSON.stringify({ error: "Tool failed to produce valid string output." }) }
                    }
                  });
                } else {
                  // CORRECT STRUCTURE:
                  functionResponses.push({
                    functionResponse: { name: functionName, response: { content: stringResult } }
                  });
                  console.log(`[${new Date().toISOString()}] <- Tool ${functionName} executed successfully.`);
                }

              } catch (error) {
                console.error(`[${new Date().toISOString()}] !!! Error executing tool ${functionName}:`, error);
                functionResponses.push({
                  functionResponse: {
                    name: functionName,
                    response: { content: JSON.stringify({ error: `Failed to execute tool: ${error.message}` }) }
                  }
                });
              }
            } else {
              console.warn(`[${new Date().toISOString()}] !!! Warning: Gemini requested unknown tool: ${functionName}`);
              functionResponses.push({
                functionResponse: {
                  name: functionName,
                  response: { content: JSON.stringify({ error: `Tool ${functionName} not found or not available.` }) }
                }
              });
            }
          } // End loop over function calls for this turn

          // --- Send function results back to Gemini ---
          if (functionResponses.length > 0) {
            console.log(`[${new Date().toISOString()}] --- Sending Function Responses Back to Gemini ---`);
            // console.log(JSON.stringify(functionResponses, null, 2)); // Keep for debugging

            // Send the array of FunctionResponseParts
            result = await chat.sendMessage(functionResponses);
            response = result.response;

            console.log(`[${new Date().toISOString()}] --- Gemini Response After Function Execution ---`);
            // console.log(JSON.stringify(response, null, 2)); // Keep for debugging
          } else {
            console.warn(`[${new Date().toISOString()}] No valid function responses generated, breaking loop.`);
            break; // Avoid potential issues if no responses were added
          }

        } // end if(currentFunctionCalls exist)

        // Continue loop IF function calls were processed in this iteration
      } while (Array.isArray(functionCalls) && functionCalls?.length > 0);


      // --- Block/Safety Checks (Check final response) ---
      if (response?.promptFeedback?.blockReason) {
        console.error(`[${new Date().toISOString()}] !!! Request blocked by Gemini. Reason: ${response.promptFeedback.blockReason}`);
        return res.status(400).json({
          error: `Request blocked due to safety settings. Reason: ${response.promptFeedback.blockReason}`,
          details: response.promptFeedback
        });
      }
      if (!response?.candidates?.[0]) {
        console.warn(`[${new Date().toISOString()}] !!! Warning: Received no candidates from Gemini final response.`);
        return res.status(500).json({ error: 'Gemini did not return any response candidates.' });
      }

      // --- Extract and Send Final Text Response ---
      const finalContent = response.candidates[0].content;
      const finalTextPart = finalContent?.parts?.find(part => part.hasOwnProperty('text')); // Ensure 'text' key exists
      const finalText = finalTextPart?.text; // Can be an empty string ""

      // Check if finalText is a string (including empty string)
      if (typeof finalText === 'string') {
        console.log(`[${new Date().toISOString()}] Sending final answer via HTTP to user ${userId || 'UNKNOWN'}: "${finalText.substring(0, 80)}..."`);

        // <<< --- SOCKET.IO INTEGRATION --- >>>
        if (userId && socketService) {
          const messagePayload = {
            userId: userId, // Or senderId etc.
            role: 'model',
            parts: [{ text: finalText }],
            timestamp: new Date().toISOString(),
            // sessionId: req.body.sessionId // Example if you use sessions
          };
          try {
            // Use the specific method from your service
            socketService.emitToUser(userId, 'chat_response', messagePayload);
            console.log(`[${new Date().toISOString()}] Emitted 'chat_response' via WebSocket to user ${userId}`);
          } catch (socketEmitError) {
            console.error(`[${new Date().toISOString()}] !!! Failed to emit WebSocket message to user ${userId}:`, socketEmitError);
            // Don't fail the HTTP request, just log the socket error
          }
        } else {
          if (!userId) console.warn(`[${new Date().toISOString()}] Cannot emit socket message: User ID not found in request.`);
          if (!socketService) console.warn(`[${new Date().toISOString()}] Cannot emit socket message: socketService not available.`);
        }
        // <<< --- END SOCKET.IO INTEGRATION --- >>>

        // Send the HTTP response
        res.json({ reply: finalText });

      } else {
        console.error(`[${new Date().toISOString()}] !!! Failed to find final text part. Final 'content' object was:`);
        console.error(JSON.stringify(finalContent, null, 2));
        res.status(500).json({ error: 'No final text content received from Gemini.' });
      }

    } catch (error) {
      console.error(`[${new Date().toISOString()}] !!! Error in /api/chat POST handler for user ${userId || 'UNKNOWN'}:`, error);
      // Provide more specific feedback if possible
      if (error.response && error.response.promptFeedback) {
        console.error("Gemini Prompt Feedback causing error:", error.response.promptFeedback);
        return res.status(400).json({ error: 'Request blocked or failed due to Gemini safety/content policy.', details: error.response.promptFeedback });
      }
      if (error.message?.includes('429')) { // Basic rate limit check
        console.warn(`[${new Date().toISOString()}] !!! Rate limit likely exceeded.`);
        return res.status(429).json({ error: 'Rate limit exceeded. Please try again later.' });
      }
      if (error.message?.includes('API key not valid')) {
        console.error(`[${new Date().toISOString()}] !!! Invalid API Key detected.`);
        return res.status(401).json({ error: 'Authentication failed: Invalid API Key.' });
      }
      // General error
      res.status(500).json({ error: 'Internal Server Error', details: error.message });
    }
  });

  // Add any other chat-related routes here (e.g., GET /history, DELETE /session)
  // router.get('/history', ...)

  return router; // Return the configured router
}; // End export function