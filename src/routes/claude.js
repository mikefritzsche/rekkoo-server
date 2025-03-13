// routes/claude.js
const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');  // Make sure to install node-fetch if not using Node 18+

// Claude suggestions endpoint
router.post('/suggestions', async (req, res) => {
    try {
        const { prompt, model, max_tokens, temperature } = req.body;

        // Make request to Claude API
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': process.env.ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: model || "claude-3-opus-20240229",
                max_tokens: max_tokens || 1024,
                messages: [{
                    role: "user",
                    content: prompt
                }],
                temperature: temperature || 0.7
            })
        });

        if (!response.ok) {
            const error = await response.json();
            console.error('Claude API error:', error);
            return res.status(response.status).json({
                error: error.error || 'Failed to get suggestions from Claude'
            });
        }

        const data = await response.json();
        console.log('Claude response:', data);

        // Extract and parse suggestions from Claude's response
        let suggestions = [];
        try {
            const content = data.content[0].text;
            // Try to extract JSON if it's wrapped in other text
            const jsonMatch = content.match(/\[.*\]/s);
            if (jsonMatch) {
                suggestions = JSON.parse(jsonMatch[0]);
            }
        } catch (parseError) {
            console.error('Error parsing Claude response:', parseError);
            return res.status(500).json({
                error: 'Failed to parse Claude response'
            });
        }

        res.json({ suggestions });

    } catch (error) {
        console.error('Error in Claude suggestions route:', error);
        res.status(500).json({
            error: 'Internal server error'
        });
    }
});

module.exports = router;