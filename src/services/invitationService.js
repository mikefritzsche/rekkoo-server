const crypto = require('crypto');
const db = require('../config/db');
const { logger } = require('../utils/logger');
const emailService = require('./emailService');

class InvitationService {
    constructor() {
        this.INVITATION_EXPIRY_DAYS = 7;
        this.CODE_LENGTH = 6;
        this.TOKEN_LENGTH = 32;
        logger.info('InvitationService initialized');
    }

    /**
     * Generate a secure random invitation code
     */
    generateInvitationCode() {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let result = '';
        for (let i = 0; i < this.CODE_LENGTH; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return result;
    }

    /**
     * Generate a secure random invitation token
     */
    generateInvitationToken() {
        return crypto.randomBytes(this.TOKEN_LENGTH).toString('hex');
    }

    /**
     * Create a new invitation
     */
    async createInvitation(inviterUserId, email, metadata = {}) {
        try {
            // Check if user exists
            const existingUserResult = await db.query(
                'SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL',
                [email]
            );

            if (existingUserResult.rows.length > 0) {
                throw new Error('User with this email already exists');
            }

            // Check for existing pending invitation
            const existingInviteResult = await db.query(
                'SELECT id FROM invitations WHERE email = $1 AND status = $2 AND deleted_at IS NULL',
                [email, 'pending']
            );

            if (existingInviteResult.rows.length > 0) {
                throw new Error('Pending invitation already exists for this email');
            }

            // Generate unique code and token
            let invitationCode, invitationToken;
            let isUnique = false;
            let attempts = 0;
            const maxAttempts = 10;

            while (!isUnique && attempts < maxAttempts) {
                invitationCode = this.generateInvitationCode();
                invitationToken = this.generateInvitationToken();

                const existingCodeResult = await db.query(
                    'SELECT id FROM invitations WHERE invitation_code = $1 OR invitation_token = $2',
                    [invitationCode, invitationToken]
                );

                if (existingCodeResult.rows.length === 0) {
                    isUnique = true;
                } else {
                    attempts++;
                }
            }

            if (!isUnique) {
                throw new Error('Unable to generate unique invitation codes');
            }

            // Calculate expiry date
            const expiresAt = new Date();
            expiresAt.setDate(expiresAt.getDate() + this.INVITATION_EXPIRY_DAYS);

            // Create invitation
            const result = await db.query(`
                INSERT INTO invitations (
                    inviter_id, email, invitation_code, invitation_token, 
                    metadata, expires_at
                ) VALUES ($1, $2, $3, $4, $5, $6)
                RETURNING *
            `, [
                inviterUserId, email, invitationCode, invitationToken,
                JSON.stringify(metadata), expiresAt
            ]);

            const invitation = result.rows[0];

            // Send invitation email
            await this.sendInvitationEmail(invitation);

            // Log sync tracking
            await this.logSyncTracking(invitation.id, inviterUserId, 'created');

            logger.info(`Invitation created: ${invitation.id} for ${email}`);
            return invitation;

        } catch (error) {
            logger.error('Error creating invitation:', error);
            throw error;
        }
    }

    /**
     * Get invitations by inviter
     */
    async getInvitationsByInviter(inviterUserId, limit = 50, offset = 0) {
        try {
            const result = await db.query(`
                SELECT i.*, u.username as inviter_username
                FROM invitations i
                JOIN users u ON i.inviter_id = u.id
                WHERE i.inviter_id = $1 AND i.deleted_at IS NULL
                ORDER BY i.created_at DESC
                LIMIT $2 OFFSET $3
            `, [inviterUserId, limit, offset]);

            return result.rows;
        } catch (error) {
            logger.error('Error getting invitations by inviter:', error);
            throw error;
        }
    }

    /**
     * Get invitation by token
     */
    async getInvitationByToken(token) {
        try {
            const result = await db.query(`
                SELECT i.*, u.username as inviter_username, u.email as inviter_email
                FROM invitations i
                JOIN users u ON i.inviter_id = u.id
                WHERE i.invitation_token = $1 AND i.deleted_at IS NULL
            `, [token]);

            return result.rows[0] || null;
        } catch (error) {
            logger.error('Error getting invitation by token:', error);
            throw error;
        }
    }

    /**
     * Get invitation by code
     */
    async getInvitationByCode(code) {
        try {
            const result = await db.query(`
                SELECT i.*, u.username as inviter_username, u.email as inviter_email
                FROM invitations i
                JOIN users u ON i.inviter_id = u.id
                WHERE i.invitation_code = $1 AND i.deleted_at IS NULL
            `, [code]);

            return result.rows[0] || null;
        } catch (error) {
            logger.error('Error getting invitation by code:', error);
            throw error;
        }
    }

    /**
     * Validate invitation
     */
    async validateInvitation(tokenOrCode) {
        try {
            let invitation = await this.getInvitationByToken(tokenOrCode);
            if (!invitation) {
                invitation = await this.getInvitationByCode(tokenOrCode);
            }

            if (!invitation) {
                return { valid: false, error: 'Invitation not found' };
            }

            if (invitation.status !== 'pending') {
                return { valid: false, error: 'Invitation is no longer valid' };
            }

            if (new Date(invitation.expires_at) < new Date()) {
                // Auto-expire the invitation
                await this.expireInvitation(invitation.id);
                return { valid: false, error: 'Invitation has expired' };
            }

            return { valid: true, invitation };
        } catch (error) {
            logger.error('Error validating invitation:', error);
            return { valid: false, error: 'Validation failed' };
        }
    }

    /**
     * Accept invitation
     */
    async acceptInvitation(invitationId, acceptedByUserId) {
        try {
            const result = await db.query(`
                UPDATE invitations 
                SET status = 'accepted', 
                    accepted_at = CURRENT_TIMESTAMP,
                    accepted_by_user_id = $1,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $2 AND status = 'pending'
                RETURNING *
            `, [acceptedByUserId, invitationId]);

            if (result.rows.length === 0) {
                throw new Error('Invitation not found or already processed');
            }

            const invitation = result.rows[0];

            // Update user with invitation info
            await db.query(`
                UPDATE users 
                SET invited_by_user_id = $1, 
                    invitation_accepted_at = CURRENT_TIMESTAMP
                WHERE id = $2
            `, [invitation.inviter_id, acceptedByUserId]);

            // Log sync tracking
            await this.logSyncTracking(invitation.id, acceptedByUserId, 'accepted');

            logger.info(`Invitation accepted: ${invitationId} by user ${acceptedByUserId}`);
            return invitation;

        } catch (error) {
            logger.error('Error accepting invitation:', error);
            throw error;
        }
    }

    /**
     * Cancel invitation
     */
    async cancelInvitation(invitationId, userId) {
        try {
            const result = await db.query(`
                UPDATE invitations 
                SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
                WHERE id = $1 AND inviter_id = $2 AND status = 'pending'
                RETURNING *
            `, [invitationId, userId]);

            if (result.rows.length === 0) {
                throw new Error('Invitation not found or cannot be cancelled');
            }

            const invitation = result.rows[0];
            await this.logSyncTracking(invitation.id, userId, 'cancelled');

            logger.info(`Invitation cancelled: ${invitationId}`);
            return invitation;

        } catch (error) {
            logger.error('Error cancelling invitation:', error);
            throw error;
        }
    }

    /**
     * Expire invitation
     */
    async expireInvitation(invitationId) {
        try {
            const result = await db.query(`
                UPDATE invitations 
                SET status = 'expired', updated_at = CURRENT_TIMESTAMP
                WHERE id = $1
                RETURNING *
            `, [invitationId]);

            return result.rows[0] || null;
        } catch (error) {
            logger.error('Error expiring invitation:', error);
            throw error;
        }
    }

    /**
     * Resend invitation
     */
    async resendInvitation(invitationId, userId) {
        try {
            const result = await db.query(`
                SELECT i.*, u.username as inviter_username
                FROM invitations i
                JOIN users u ON i.inviter_id = u.id
                WHERE i.id = $1 AND i.inviter_id = $2 AND i.status = 'pending'
            `, [invitationId, userId]);

            if (result.rows.length === 0) {
                throw new Error('Invitation not found or cannot be resent');
            }

            const invitation = result.rows[0];

            // Check if not expired
            if (new Date(invitation.expires_at) < new Date()) {
                throw new Error('Cannot resend expired invitation');
            }

            // Send invitation email
            await this.sendInvitationEmail(invitation);

            // Log sync tracking
            await this.logSyncTracking(invitation.id, userId, 'resent');

            logger.info(`Invitation resent: ${invitationId}`);
            return invitation;

        } catch (error) {
            logger.error('Error resending invitation:', error);
            throw error;
        }
    }

    /**
     * Send invitation email
     */
    async sendInvitationEmail(invitation) {
        try {
            // Get inviter info
            const inviterResult = await db.query(
                'SELECT username, email FROM users WHERE id = $1',
                [invitation.inviter_id]
            );

            const inviter = inviterResult.rows[0];
            const metadata = JSON.parse(invitation.metadata || '{}');
            
            await emailService.sendInvitationEmail(
                invitation.email,
                invitation.invitation_token,
                invitation.invitation_code,
                inviter,
                metadata
            );

        } catch (error) {
            logger.error('Error sending invitation email:', error);
            // Don't throw - invitation created successfully, email failure is secondary
        }
    }

    /**
     * Log sync tracking
     */
    async logSyncTracking(invitationId, userId, action) {
        try {
            await db.query(`
                INSERT INTO invitation_sync_tracking (invitation_id, user_id, action)
                VALUES ($1, $2, $3)
            `, [invitationId, userId, action]);
        } catch (error) {
            logger.error('Error logging sync tracking:', error);
            // Don't throw - sync tracking failure is not critical
        }
    }

    /**
     * Get invitation statistics
     */
    async getInvitationStats(userId = null) {
        try {
            const whereClause = userId ? 'WHERE inviter_id = $1 AND deleted_at IS NULL' : 'WHERE deleted_at IS NULL';
            const params = userId ? [userId] : [];

            const result = await db.query(`
                SELECT 
                    COUNT(*) as total_invitations,
                    COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_invitations,
                    COUNT(CASE WHEN status = 'accepted' THEN 1 END) as accepted_invitations,
                    COUNT(CASE WHEN status = 'expired' THEN 1 END) as expired_invitations,
                    COUNT(CASE WHEN status = 'cancelled' THEN 1 END) as cancelled_invitations
                FROM invitations 
                ${whereClause}
            `, params);

            return result.rows[0];
        } catch (error) {
            logger.error('Error getting invitation stats:', error);
            throw error;
        }
    }

    /**
     * Clean up expired invitations (call periodically)
     */
    async cleanupExpiredInvitations() {
        try {
            const result = await db.query(`
                UPDATE invitations 
                SET status = 'expired', updated_at = CURRENT_TIMESTAMP
                WHERE status = 'pending' 
                AND expires_at < CURRENT_TIMESTAMP
                RETURNING id
            `);

            logger.info(`Cleaned up ${result.rows.length} expired invitations`);
            return result.rows.length;
        } catch (error) {
            logger.error('Error cleaning up expired invitations:', error);
            throw error;
        }
    }
}

module.exports = new InvitationService(); 