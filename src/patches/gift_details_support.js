// Server-side changes to support gift_details
// This file documents the changes needed - apply them to the respective files

// 1. Update SyncController.js - Add gift to DETAIL_TABLES_MAP (around line 22)
/*
const DETAIL_TABLES_MAP = {
  movie: 'movie_details',
  book: 'book_details',
  place: 'place_details',
  spotify_item: 'spotify_item_details',
  tv: 'tv_details',
  gift: 'gift_details'  // ADD THIS LINE
};
*/

// 2. Update ListService.js - Add gift_details to tableColumnMap (around line 69)
/*
const tableColumnMap = {
  // ... existing mappings ...
  gift_details: {
    quantity: 'quantity',
    where_to_buy: 'whereToBuy',
    amazon_url: 'amazonUrl',
    web_link: 'webLink',
    rating: 'rating'
  },
  // ... rest of mappings ...
};
*/

// 3. Create new helper function for handling gift items with details
const handleGiftItemWithDetails = async (client, itemData, userId) => {
  const { gift_detail_id, quantity, whereToBuy, amazonUrl, webLink, rating, ...baseItemData } = itemData;
  
  // If gift fields are present, create or update gift_details
  if (quantity || whereToBuy || amazonUrl || webLink || rating) {
    let giftDetailId = gift_detail_id;
    
    if (giftDetailId) {
      // Update existing gift_details
      await client.query(`
        UPDATE gift_details 
        SET quantity = $1, where_to_buy = $2, amazon_url = $3, web_link = $4, rating = $5, updated_at = CURRENT_TIMESTAMP
        WHERE id = $6`,
        [quantity, whereToBuy, amazonUrl, webLink, rating, giftDetailId]
      );
    } else {
      // Create new gift_details
      const result = await client.query(`
        INSERT INTO gift_details (list_item_id, quantity, where_to_buy, amazon_url, web_link, rating)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id`,
        [baseItemData.id, quantity, whereToBuy, amazonUrl, webLink, rating]
      );
      giftDetailId = result.rows[0].id;
      
      // Update list_item with gift_detail_id
      await client.query(
        'UPDATE list_items SET gift_detail_id = $1 WHERE id = $2',
        [giftDetailId, baseItemData.id]
      );
    }
    
    return { ...baseItemData, gift_detail_id: giftDetailId };
  }
  
  return baseItemData;
};

// 4. Query modification for fetching items with gift_details
const fetchItemsWithGiftDetails = `
  SELECT 
    li.*,
    gd.quantity as gift_quantity,
    gd.where_to_buy as gift_where_to_buy,
    gd.amazon_url as gift_amazon_url,
    gd.web_link as gift_web_link,
    gd.rating as gift_rating
  FROM list_items li
  LEFT JOIN gift_details gd ON li.gift_detail_id = gd.id
  WHERE li.list_id = $1 AND li.deleted_at IS NULL
`;

module.exports = {
  handleGiftItemWithDetails,
  fetchItemsWithGiftDetails
};