const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { authenticateJWT, checkPermissions } = require('../auth/middleware');
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

// Public beta waitlist rate limiting - keyed by requester IP
const waitlistRateLimit = new Map();
const WAITLIST_WINDOW = 60 * 60 * 1000; // 1 hour
const WAITLIST_MAX_REQUESTS = 5;

const checkWaitlistRateLimit = (req, res, next) => {
    const key = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    const now = Date.now();

    if (!waitlistRateLimit.has(key)) {
        waitlistRateLimit.set(key, { count: 0, resetTime: now + WAITLIST_WINDOW });
    }

    const entry = waitlistRateLimit.get(key);

    if (now > entry.resetTime) {
        entry.count = 0;
        entry.resetTime = now + WAITLIST_WINDOW;
    }

    if (entry.count >= WAITLIST_MAX_REQUESTS) {
        return res.status(429).json({
            success: false,
            error: 'Too many requests. Please try again later.'
        });
    }

    entry.count++;
    next();
};

// Public endpoint: allow unauthenticated users to join beta waitlist
router.post('/beta-waitlist',
    checkWaitlistRateLimit,
    [
        body('email').isEmail().withMessage('Valid email is required').normalizeEmail(),
        body('name').optional().isString().trim().isLength({ max: 120 }),
        body('context').optional().isString().trim().isLength({ max: 200 })
    ],
    validateRequest,
    async (req, res) => {
        try {
            const { email, name, context } = req.body;
            const metadata = {
                name: name || null,
                context: context || 'landing_waitlist',
                user_agent: req.get('user-agent') || null,
                ip_address: req.ip || null
            };

            const entry = await invitationService.addToBetaWaitlist(email, metadata);

            res.json({
                success: true,
                entry: {
                    id: entry.id,
                    email: entry.email,
                    status: entry.status,
                    created_at: entry.created_at,
                    updated_at: entry.updated_at
                }
            });
        } catch (error) {
            console.error('Error adding beta waitlist entry:', error);
            res.status(500).json({
                success: false,
                error: 'Unable to submit your request at this time.'
            });
        }
    }
);

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
                metadata: invitationService.parseMetadata(inv.metadata)
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
                metadata: invitationService.parseMetadata(validation.invitation.metadata)
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

// Admin endpoint to generate beta invitation codes
router.post('/admin/beta-generate', [
    authenticateJWT,
    checkPermissions(['admin:manage_invitations']),
    body('count')
        .isInt({ min: 1, max: 100 })
        .withMessage('Count must be between 1 and 100'),
    body('metadata').optional().isObject(),
    validateRequest
], async (req, res) => {
    try {
        const { count, metadata = {} } = req.body;
        const invitations = [];

        for (let i = 0; i < count; i++) {
            const invitation = await invitationService.createInvitation(
                req.user.id,
                `beta+${Date.now()}+${i}@rekkoo.com`, // Placeholder email
                { ...metadata, source: 'beta_program', batch_id: Date.now() }
            );
            invitations.push({
                id: invitation.id,
                code: invitation.invitation_code,
                url: `${process.env.CLIENT_URL_APP || 'https://app.rekkoo.com'}/beta-signup?code=${invitation.invitation_code}`,
                expires_at: invitation.expires_at
            });
        }

        res.json({
            success: true,
            invitations,
            total: count
        });
    } catch (error) {
        console.error('Error generating beta invitations:', error);
        res.status(500).json({ error: error.message });
    }
});

// Admin endpoint to get beta statistics
router.get('/admin/beta-stats', [
    authenticateJWT,
    checkPermissions(['admin:manage_invitations'])
], async (req, res) => {
    try {
        const stats = await invitationService.getBetaStats();
        res.json({ success: true, stats });
    } catch (error) {
        console.error('Error getting beta stats:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router; 
