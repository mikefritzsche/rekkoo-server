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
        
        // Only validate data for create and update operations
        if (operation !== 'delete' && !data) {
          return res.status(400).json({ error: 'Data is required for list changes' });
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

          // Validate constraints
          if (data.is_event && !data.event_date) {
            return res.status(400).json({ error: 'Event date is required when is_event is true' });
          }

          if (data.sort_order !== undefined && data.sort_order < 0) {
            return res.status(400).json({ error: 'Sort order must be non-negative' });
          }

          if (data.background) {
            try {
              // Allow 'local' type during sync push
              if (!['color', 'image', 'local', 'pattern', 'stock', 'remote'].includes(data.background.type)) {
                return res.status(400).json({ error: `Invalid background type: ${data.background.type}` });
              }
              // Value is required for color/image, but not necessarily for local (blob uri isn't useful server-side)
              if (data.background.type !== 'local' && data.background.type !== 'pattern' && !data.background.value) {
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

      // ... rest of the validation logic ...
    }
  }

  next();
};

module.exports = validateListData;