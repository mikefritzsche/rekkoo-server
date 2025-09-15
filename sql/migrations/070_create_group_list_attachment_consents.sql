-- Migration: Create group_list_attachment_consents table for explicit user consent
-- This ensures users must approve when their groups are attached to lists

BEGIN;

-- Create enum for consent status
DO $$ BEGIN
  CREATE TYPE consent_status AS ENUM ('pending', 'accepted', 'declined', 'revoked');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Create group_list_attachment_consents table
CREATE TABLE IF NOT EXISTS group_list_attachment_consents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id UUID NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  group_id UUID NOT NULL REFERENCES collaboration_groups(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status consent_status NOT NULL DEFAULT 'pending',
  consented_at TIMESTAMP WITH TIME ZONE,
  declined_at TIMESTAMP WITH TIME ZONE,
  revoked_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT unique_user_consent_per_list_group UNIQUE(list_id, group_id, user_id),
  CONSTRAINT valid_status_timestamps CHECK (
    (status = 'pending' AND consented_at IS NULL AND declined_at IS NULL AND revoked_at IS NULL) OR
    (status = 'accepted' AND consented_at IS NOT NULL AND declined_at IS NULL AND revoked_at IS NULL) OR
    (status = 'declined' AND declined_at IS NOT NULL AND consented_at IS NULL AND revoked_at IS NULL) OR
    (status = 'revoked' AND revoked_at IS NOT NULL)
  )
);

-- Create indexes for efficient queries
CREATE INDEX idx_consents_user_pending ON group_list_attachment_consents(user_id, status)
  WHERE status = 'pending';
CREATE INDEX idx_consents_group_list ON group_list_attachment_consents(group_id, list_id);
CREATE INDEX idx_consents_user_accepted ON group_list_attachment_consents(user_id, list_id, group_id)
  WHERE status = 'accepted';

-- Function to check if user has consented to list access through group
CREATE OR REPLACE FUNCTION user_has_consented_to_list_group(
  p_user_id UUID,
  p_list_id UUID,
  p_group_id UUID
) RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1
    FROM group_list_attachment_consents
    WHERE user_id = p_user_id
      AND list_id = p_list_id
      AND group_id = p_group_id
      AND status = 'accepted'
  );
END;
$$ LANGUAGE plpgsql;

-- Function to create pending consents for all group members when list is attached
CREATE OR REPLACE FUNCTION create_group_list_attachment_consents()
RETURNS TRIGGER AS $$
DECLARE
  v_member RECORD;
  v_list_name VARCHAR(255);
  v_group_name VARCHAR(255);
BEGIN
  -- Get list and group names for notifications
  SELECT name INTO v_list_name FROM lists WHERE id = NEW.list_id;
  SELECT name INTO v_group_name FROM collaboration_groups WHERE id = NEW.group_id;

  -- Create pending consent for each group member
  FOR v_member IN
    SELECT user_id
    FROM collaboration_group_members
    WHERE group_id = NEW.group_id
      AND deleted_at IS NULL
  LOOP
    -- Insert consent record
    INSERT INTO group_list_attachment_consents (
      list_id,
      group_id,
      user_id,
      status,
      created_at,
      updated_at
    ) VALUES (
      NEW.list_id,
      NEW.group_id,
      v_member.user_id,
      'pending',
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    )
    ON CONFLICT (list_id, group_id, user_id) DO NOTHING;

    -- Create notification for the user
    INSERT INTO notifications (
      user_id,
      notification_type,
      title,
      body,
      data,
      is_read,
      created_at
    ) VALUES (
      v_member.user_id,
      'group_list_attachment',
      'New List Added to Group',
      format('The list "%s" has been added to your group "%s". Your approval is required to access it.', v_list_name, v_group_name),
      jsonb_build_object(
        'list_id', NEW.list_id,
        'group_id', NEW.group_id,
        'list_name', v_list_name,
        'group_name', v_group_name
      ),
      FALSE,
      CURRENT_TIMESTAMP
    );
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to create consents when a list is attached to a group
CREATE TRIGGER trigger_create_consents_on_list_group_attach
  AFTER INSERT ON list_group_roles
  FOR EACH ROW
  EXECUTE FUNCTION create_group_list_attachment_consents();

-- Function to create pending consents when user joins a group
CREATE OR REPLACE FUNCTION create_consents_for_new_group_member()
RETURNS TRIGGER AS $$
DECLARE
  v_list RECORD;
BEGIN
  -- Only process for new accepted members
  IF NEW.deleted_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Create pending consent for each list attached to the group
  FOR v_list IN
    SELECT lgr.list_id, l.name as list_name
    FROM list_group_roles lgr
    JOIN lists l ON l.id = lgr.list_id
    WHERE lgr.group_id = NEW.group_id
      AND lgr.deleted_at IS NULL
  LOOP
    -- Insert consent record
    INSERT INTO group_list_attachment_consents (
      list_id,
      group_id,
      user_id,
      status,
      created_at,
      updated_at
    ) VALUES (
      v_list.list_id,
      NEW.group_id,
      NEW.user_id,
      'pending',
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    )
    ON CONFLICT (list_id, group_id, user_id) DO NOTHING;

    -- Create notification
    INSERT INTO notifications (
      user_id,
      notification_type,
      title,
      body,
      data,
      is_read,
      created_at
    ) VALUES (
      NEW.user_id,
      'group_list_consent_required',
      'List Access Approval Required',
      format('Your group has access to "%s". Please approve to view this list.', v_list.list_name),
      jsonb_build_object(
        'list_id', v_list.list_id,
        'group_id', NEW.group_id,
        'list_name', v_list.list_name
      ),
      FALSE,
      CURRENT_TIMESTAMP
    );
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to create consents when user joins a group
CREATE TRIGGER trigger_create_consents_on_group_join
  AFTER INSERT OR UPDATE ON collaboration_group_members
  FOR EACH ROW
  EXECUTE FUNCTION create_consents_for_new_group_member();

-- Function to accept consent for list attachment
CREATE OR REPLACE FUNCTION accept_group_list_consent(
  p_user_id UUID,
  p_list_id UUID,
  p_group_id UUID
) RETURNS BOOLEAN AS $$
DECLARE
  v_updated INTEGER;
BEGIN
  UPDATE group_list_attachment_consents
  SET status = 'accepted',
      consented_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  WHERE user_id = p_user_id
    AND list_id = p_list_id
    AND group_id = p_group_id
    AND status = 'pending';

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated > 0 THEN
    -- Create change log entry for the user to sync the list
    INSERT INTO change_log (
      table_name,
      record_id,
      operation,
      user_id,
      created_at
    ) VALUES (
      'lists',
      p_list_id,
      'update',
      p_user_id,
      CURRENT_TIMESTAMP
    );
  END IF;

  RETURN v_updated > 0;
END;
$$ LANGUAGE plpgsql;

-- Function to decline consent for list attachment
CREATE OR REPLACE FUNCTION decline_group_list_consent(
  p_user_id UUID,
  p_list_id UUID,
  p_group_id UUID
) RETURNS BOOLEAN AS $$
DECLARE
  v_updated INTEGER;
BEGIN
  UPDATE group_list_attachment_consents
  SET status = 'declined',
      declined_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  WHERE user_id = p_user_id
    AND list_id = p_list_id
    AND group_id = p_group_id
    AND status = 'pending';

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$ LANGUAGE plpgsql;

-- Function to get pending consents for a user
CREATE OR REPLACE FUNCTION get_pending_group_list_consents(p_user_id UUID)
RETURNS TABLE (
  consent_id UUID,
  list_id UUID,
  list_name VARCHAR(255),
  list_type VARCHAR(50),
  group_id UUID,
  group_name VARCHAR(255),
  created_at TIMESTAMP WITH TIME ZONE
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    glac.id as consent_id,
    glac.list_id,
    l.name as list_name,
    l.list_type,
    glac.group_id,
    cg.name as group_name,
    glac.created_at
  FROM group_list_attachment_consents glac
  JOIN lists l ON l.id = glac.list_id
  JOIN collaboration_groups cg ON cg.id = glac.group_id
  WHERE glac.user_id = p_user_id
    AND glac.status = 'pending'
  ORDER BY glac.created_at DESC;
END;
$$ LANGUAGE plpgsql;

-- Modify list access check to require consent
CREATE OR REPLACE FUNCTION user_can_access_list_through_group(
  p_user_id UUID,
  p_list_id UUID
) RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1
    FROM list_group_roles lgr
    JOIN collaboration_group_members cgm ON cgm.group_id = lgr.group_id
    JOIN group_list_attachment_consents glac ON (
      glac.list_id = lgr.list_id
      AND glac.group_id = lgr.group_id
      AND glac.user_id = cgm.user_id
    )
    WHERE lgr.list_id = p_list_id
      AND cgm.user_id = p_user_id
      AND cgm.deleted_at IS NULL
      AND lgr.deleted_at IS NULL
      AND glac.status = 'accepted'  -- Must have consented
  );
END;
$$ LANGUAGE plpgsql;

-- Add comment to the table
COMMENT ON TABLE group_list_attachment_consents IS 'Tracks user consent for accessing lists through their groups, ensuring explicit approval for each list-group attachment';

COMMIT;