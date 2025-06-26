const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { authenticateJWT } = require('../auth/middleware');
const invitationService = require('../services/invitationService');

// Validation middleware
const validateRequest = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }
    next();
};

// Rate limiting for invitation creation (simple in-memory implementation)
const invitationRateLimit = new Map();
const RATE_LIMIT_WINDOW = 24 * 60 * 60 * 1000; // 24 hours
const MAX_INVITATIONS_PER_DAY = 10;

const checkRateLimit = (req, res, next) => {
    const userId = req.user.id;
    const now = Date.now();
    
    if (!invitationRateLimit.has(userId)) {
        invitationRateLimit.set(userId, { count: 0, resetTime: now + RATE_LIMIT_WINDOW });
    }
    
    const userLimit = invitationRateLimit.get(userId);
    
    if (now > userLimit.resetTime) {
        userLimit.count = 0;
        userLimit.resetTime = now + RATE_LIMIT_WINDOW;
    }
    
    if (userLimit.count >= MAX_INVITATIONS_PER_DAY) {
        return res.status(429).json({ 
            error: 'Too many invitations sent today. Please try again tomorrow.' 
        });
    }
    
    userLimit.count++;
    next();
};

// Create invitation
router.post('/', 
    authenticateJWT,
    checkRateLimit,
    [
        body('email').isEmail().normalizeEmail(),
        body('message').optional().isString().trim().escape()
    ],
    validateRequest,
    async (req, res) => {
        try {
            const { email, message } = req.body;
            const metadata = message ? { message } : {};
            
            const invitation = await invitationService.createInvitation(
                req.user.id, 
                email, 
                metadata
            );
            
            res.json({
                success: true,
                invitation: {
                    id: invitation.id,
                    email: invitation.email,
                    invitation_code: invitation.invitation_code,
                    status: invitation.status,
                    expires_at: invitation.expires_at,
                    created_at: invitation.created_at
                }
            });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
);

// Get user's invitations
router.get('/', authenticateJWT, async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const offset = parseInt(req.query.offset) || 0;
        
        const invitations = await invitationService.getInvitationsByInviter(
            req.user.id, 
            limit, 
            offset
        );
        
        res.json({
            success: true,
            invitations: invitations.map(inv => ({
                id: inv.id,
                email: inv.email,
                invitation_code: inv.invitation_code,
                status: inv.status,
                expires_at: inv.expires_at,
                created_at: inv.created_at,
                metadata: JSON.parse(inv.metadata || '{}')
            }))
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Validate invitation by token or code
router.get('/validate/:tokenOrCode', async (req, res) => {
    try {
        const { tokenOrCode } = req.params;
        const validation = await invitationService.validateInvitation(tokenOrCode);
        
        if (!validation.valid) {
            return res.status(400).json({ 
                valid: false, 
                error: validation.error 
            });
        }
        
        res.json({
            valid: true,
            invitation: {
                id: validation.invitation.id,
                email: validation.invitation.email,
                inviter_username: validation.invitation.inviter_username,
                expires_at: validation.invitation.expires_at,
                metadata: JSON.parse(validation.invitation.metadata || '{}')
            }
        });
    } catch (error) {
        res.status(500).json({ error: 'Validation failed' });
    }
});

// Accept invitation (called during registration)
router.post('/:id/accept', authenticateJWT, async (req, res) => {
    try {
        const invitationId = req.params.id;
        const invitation = await invitationService.acceptInvitation(invitationId, req.user.id);
        
        res.json({
            success: true,
            invitation: {
                id: invitation.id,
                status: invitation.status,
                accepted_at: invitation.accepted_at
            }
        });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// Cancel invitation
router.delete('/:id', authenticateJWT, async (req, res) => {
    try {
        const invitationId = req.params.id;
        const invitation = await invitationService.cancelInvitation(invitationId, req.user.id);
        
        res.json({
            success: true,
            invitation: {
                id: invitation.id,
                status: invitation.status
            }
        });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// Resend invitation
router.post('/:id/resend', authenticateJWT, async (req, res) => {
    try {
        const invitationId = req.params.id;
        const invitation = await invitationService.resendInvitation(invitationId, req.user.id);
        
        res.json({
            success: true,
            invitation: {
                id: invitation.id,
                email: invitation.email,
                status: invitation.status
            }
        });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// Get invitation statistics
router.get('/stats', authenticateJWT, async (req, res) => {
    try {
        const stats = await invitationService.getInvitationStats(req.user.id);
        res.json({ success: true, stats });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router; 