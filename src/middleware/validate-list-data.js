// Update /app/src/middleware/validate-list-data.js
const validateListData = (req, res, next) => {
  // For sync/push endpoint, data is in changes array
  if (req.originalUrl.includes('/sync/push')) {
    const { changes } = req.body;
    if (!Array.isArray(changes)) {
      return res.status(400).json({ error: 'Changes must be an array' });
    }

    // Validate each change
    for (const change of changes) {
      if (change.table_name === 'lists') {
        const { data, operation } = change;
        
        // Only validate data for create and update operations (and not batch order update for data presence)
        if (operation !== 'delete' && operation !== 'BATCH_LIST_ORDER_UPDATE' && !data) {
          return res.status(400).json({ error: 'Data is required for list changes' });
        }

        // Validate required fields only for create and update operations,
        // and skip for BATCH_LIST_ORDER_UPDATE as it only needs id and sort_order from the main data payload.
        if (operation !== 'delete' && operation !== 'BATCH_LIST_ORDER_UPDATE') {
          if (!data.title) {
            return res.status(400).json({ error: 'Title is required' });
          }
          if (!data.list_type) {
            return res.status(400).json({ error: 'List type is required' });
          }
           if (!data.owner_id) {
            return res.status(400).json({ error: 'Owner ID is required' });
          }

          // Validate constraints
          if (data.is_event && !data.event_date) {
            return res.status(400).json({ error: 'Event date is required when is_event is true' });
          }

          if (data.travel_start_date && Number.isNaN(new Date(data.travel_start_date).getTime())) {
            return res.status(400).json({ error: 'Invalid travel_start_date value' });
          }

          if (data.travel_end_date && Number.isNaN(new Date(data.travel_end_date).getTime())) {
            return res.status(400).json({ error: 'Invalid travel_end_date value' });
          }

          if (data.travel_start_date && data.travel_end_date) {
            if (new Date(data.travel_start_date).getTime() > new Date(data.travel_end_date).getTime()) {
              return res.status(400).json({ error: 'travel_start_date must be before travel_end_date' });
            }
          }

          if (data.sort_order !== undefined && data.sort_order < 0) {
            return res.status(400).json({ error: 'Sort order must be non-negative' });
          }

          if (data.background) {
            try {
              // Accept known client background types, including pending local uploads
              const allowedBackgroundTypes = [
                'color',
                'image',
                'local',
                'local_pending_upload',
                'pattern',
                'stock',
                'remote',
              ];
              if (!allowedBackgroundTypes.includes(data.background.type)) {
                return res.status(400).json({ error: `Invalid background type: ${data.background.type}` });
              }

              const typeAllowsEmptyValue = ['local', 'local_pending_upload', 'pattern'];
              // Value is required for most types; local variants and patterns can omit it
              if (!typeAllowsEmptyValue.includes(data.background.type) && !data.background.value) {
                return res.status(400).json({ error: `Background value is required for type ${data.background.type}` });
              }
              // Image ID check is only relevant for type 'image' (stock images likely use different field)
              if (data.background.type === 'image' && !data.background.image_id) {
                // Potentially relax this if image_id isn't strictly required or comes later
                // return res.status(400).json({ error: 'Image ID is required for image background' });
              }
              // Add check for stock type if needed
              // if (data.background.type === 'stock' && !data.background.imageId) {
              //   return res.status(400).json({ error: 'Image ID is required for stock background' });
              // }
            } catch (error) {
              return res.status(400).json({ error: `Invalid background format: ${error.message}` });
            }
          }

          if (data.image_url) {
            try {
              new URL(data.image_url);
            } catch (error) {
              return res.status(400).json({ error: 'Invalid image URL format' });
            }
          }
        }

        // For BATCH_LIST_ORDER_UPDATE, the 'data' field itself contains an 'items' array.
        // We can add a basic check here if needed, e.g., ensuring 'items' is an array.
        // However, the core validation of individual list items within the batch
        // (like ensuring each has an 'id' and 'sort_order') would ideally be in the ListService.
        // For now, we'll assume the ListService handles the specifics of the batch payload.
        if (operation === 'BATCH_LIST_ORDER_UPDATE') {
            if (!data || !Array.isArray(data.items) || data.items.length === 0) {
                return res.status(400).json({ error: 'Data for BATCH_LIST_ORDER_UPDATE must contain a non-empty "items" array.' });
            }
            // Optional: iterate through data.items to ensure each has id and sort_order if desired here.
            // for (const item of data.items) {
            //   if (item.id === undefined || item.sort_order === undefined) {
            //     return res.status(400).json({ error: 'Each item in BATCH_LIST_ORDER_UPDATE must have an id and sort_order.' });
            //   }
            // }
        }
      } else if (change.table_name === 'list_sharing') {
        // Basic validation for list_sharing records coming through sync
        const { data, operation } = change;
        if (operation !== 'delete') {
          if (!data) return res.status(400).json({ error: 'Data is required for list_sharing changes' });
          if (!data.list_id) return res.status(400).json({ error: 'list_id is required for list_sharing' });
          if (!data.shared_with_user_id && !data.shared_with_group_id) {
            return res.status(400).json({ error: 'Either shared_with_user_id or shared_with_group_id must be provided' });
          }
        }
      }
    }
  } else {
    // For direct list endpoints, data is in the request body
    const { data, operation } = req.body;
    
    // Only validate data for create and update operations
    if (operation !== 'delete' && !data) {
      return res.status(400).json({ error: 'Data is required' });
    }

    // Validate required fields only for create and update operations
    if (operation !== 'delete') {
      if (!data.title) {
        return res.status(400).json({ error: 'Title is required' });
      }
      if (!data.list_type) {
        return res.status(400).json({ error: 'List type is required' });
      }
      if (!data.owner_id) {
        return res.status(400).json({ error: 'Owner ID is required' });
      }

      if (data.travel_start_date && Number.isNaN(new Date(data.travel_start_date).getTime())) {
        return res.status(400).json({ error: 'Invalid travel_start_date value' });
      }

      if (data.travel_end_date && Number.isNaN(new Date(data.travel_end_date).getTime())) {
        return res.status(400).json({ error: 'Invalid travel_end_date value' });
      }

      if (data.travel_start_date && data.travel_end_date) {
        if (new Date(data.travel_start_date).getTime() > new Date(data.travel_end_date).getTime()) {
          return res.status(400).json({ error: 'travel_start_date must be before travel_end_date' });
        }
      }

      // ... rest of the validation logic ...
    }
  }

  next();
};

module.exports = validateListData;
