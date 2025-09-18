-- Migration: Fix references to lists.name column (should be lists.title)
-- This fixes trigger functions that incorrectly reference lists.name instead of lists.title

BEGIN;

-- Fix create_group_list_attachment_consents function
CREATE OR REPLACE FUNCTION create_group_list_attachment_consents()
RETURNS TRIGGER AS $$
DECLARE
  v_member RECORD;
  v_list_name VARCHAR(255);
  v_group_name VARCHAR(255);
BEGIN
  -- Get list and group names for notifications - FIX: use title instead of name for lists
  SELECT title INTO v_list_name FROM lists WHERE id = NEW.list_id;
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

-- Fix create_consents_for_new_group_member function
CREATE OR REPLACE FUNCTION create_consents_for_new_group_member()
RETURNS TRIGGER AS $$
DECLARE
  v_list RECORD;
BEGIN
  -- Only process for new accepted members
  IF NEW.deleted_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Create pending consent for each list attached to the group - FIX: use title instead of name
  FOR v_list IN
    SELECT lgr.list_id, l.title as list_name
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

-- Fix get_pending_group_list_consents function
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
    l.title as list_name,  -- FIX: use title instead of name
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

COMMIT;