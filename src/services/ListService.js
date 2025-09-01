const { transaction } = require('../config/db');
const { logger } = require('../utils/logger');

class ListService {
  /**
   * Batch updates the sort_order for multiple lists.
   * @param {Array<{id: string, sort_order: number, updated_at?: string}>} listOrders - An array of objects,
   * each containing the id and the new sort_order for a list.
   * An optional updated_at can be included if client wants to pass it for optimistic concurrency,
   * though the server will set its own updated_at.
   * @returns {Promise<void>}
   * @throws {Error} if the database operation fails.
   */
  async batchUpdateListOrder(listOrders) {
    if (!Array.isArray(listOrders) || listOrders.length === 0) {
      logger.warn('[ListService.batchUpdateListOrder] Received empty or invalid listOrders array.');
      // Consider if this should throw an error or just return. For now, it's a no-op.
      return;
    }

    logger.info(`[ListService.batchUpdateListOrder] Starting batch update for ${listOrders.length} lists.`);

    return transaction(async (client) => {
      for (const orderInfo of listOrders) {
        if (!orderInfo || typeof orderInfo.id !== 'string' || typeof orderInfo.sort_order !== 'number') {
          logger.error('[ListService.batchUpdateListOrder] Invalid item in listOrders array:', orderInfo);
          throw new Error('Invalid data in list update batch. Each item must have an id and sort_order.');
        }
        
        const queryText = 'UPDATE lists SET sort_order = $1, updated_at = NOW() WHERE id = $2';
        const queryParams = [orderInfo.sort_order, orderInfo.id];
        
        logger.debug(`[ListService.batchUpdateListOrder] Executing query for list ${orderInfo.id}: ${queryText} with params ${JSON.stringify(queryParams)}`);
        
        const result = await client.query(queryText, queryParams);

        if (result.rowCount === 0) {
          // This could mean the list ID was not found.
          // Depending on requirements, this could be an error or just a warning.
          logger.warn(`[ListService.batchUpdateListOrder] List with ID ${orderInfo.id} not found during batch update. No rows affected.`);
          // If this should be a hard error, uncomment the next line:
          // throw new Error(`List with ID ${orderInfo.id} not found during batch update.`);
        }
      }
      logger.info(`[ListService.batchUpdateListOrder] Successfully updated sort_order for ${listOrders.length} lists.`);
    });
  }

  async createDetailRecord(client, tableName, apiMetadata, listItemId, listItemData) {
    if (!listItemId) {
      logger.error('[ListService.createDetailRecord] listItemId is required.');
      throw new Error('listItemId is required to create a detail record.');
    }
    
    // Add debug logging for movie_details
    if (tableName === 'movie_details') {
      logger.info(`[ListService.createDetailRecord] Processing movie_details for item ${listItemId}`);
      logger.info(`[ListService.createDetailRecord] apiMetadata:`, typeof apiMetadata === 'string' ? apiMetadata : JSON.stringify(apiMetadata));
      logger.info(`[ListService.createDetailRecord] listItemData:`, JSON.stringify(listItemData));
    }
    
    // Add debug logging for book_details
    if (tableName === 'book_details') {
      logger.info(`[ListService.createDetailRecord] Processing book_details for item ${listItemId}`);
      logger.info(`[ListService.createDetailRecord] apiMetadata:`, typeof apiMetadata === 'string' ? apiMetadata : JSON.stringify(apiMetadata));
      logger.info(`[ListService.createDetailRecord] listItemData:`, JSON.stringify(listItemData));
    }

    const tableColumnMap = {
      movie_details: {
        tmdb_id: 'source_id',
        release_date: 'release_date',
        rating: 'raw_details.vote_average',
        genres: 'raw_details.genres',
        tagline: 'subtitle',
        vote_count: 'raw_details.vote_count',
        runtime_minutes: 'raw_details.runtime',
        original_language: 'raw_details.original_language',
        original_title: 'raw_details.original_title',
        popularity: 'raw_details.popularity',
        backdrop_path: 'raw_details.backdrop_path',
        poster_path: 'raw_details.poster_path',
        budget: 'raw_details.budget',
        revenue: 'raw_details.revenue',
        status: 'raw_details.status',
        production_companies: 'raw_details.production_companies',
        production_countries: 'raw_details.production_countries',
        spoken_languages: 'raw_details.spoken_languages',
        watch_providers: 'raw_details.watch_providers',
        title: 'title',
        overview: 'raw_details.overview',
      },
      book_details: {
        google_book_id: 'source_id',
        authors: 'raw_details.authors',
        publisher: 'raw_details.publisher',
        published_date: 'raw_details.publishedDate',
        page_count: 'raw_details.pageCount',
        isbn_13: 'raw_details.industryIdentifiers.ISBN_13',
        isbn_10: 'raw_details.industryIdentifiers.ISBN_10',
        categories: 'raw_details.categories',
        average_rating_google: 'raw_details.averageRating',
        ratings_count_google: 'raw_details.ratingsCount',
        language: 'raw_details.language',
        info_link: 'raw_details.infoLink',
        canonical_volume_link: 'raw_details.canonicalVolumeLink',
      },
      place_details: {
        // Prefer explicit source_id but fall back to place_id from raw/metadata
        google_place_id: 'source_id', // will be normalized below if missing
        address_formatted: 'raw_details.formatted_address', // correct Google field
        phone_number_international: 'raw_details.international_phone_number',
        website: 'raw_details.website',
        rating_google: 'raw_details.rating',
        user_ratings_total_google: 'raw_details.user_ratings_total',
        price_level_google: 'raw_details.price_level',
        latitude: 'raw_details.geometry.location.lat',
        longitude: 'raw_details.geometry.location.lng',
        google_maps_url: 'raw_details.url',
        business_status: 'raw_details.business_status',
        types: 'raw_details.types',
        photos: 'raw_details.photos',
      },
      recipe_details: {
        title: 'title',
        summary: 'raw_details.summary',
        image_url: 'image_url',
        source_url: 'raw_details.sourceUrl',
        servings: 'raw_details.servings',
        cook_time: 'raw_details.readyInMinutes',
      },
      tv_details: {
        tmdb_id: 'source_id',
        first_air_date: 'release_date', // Mapping release_date to first_air_date
        rating: 'raw_details.vote_average',
        genres: 'raw_details.genres',
        tagline: 'subtitle',
        vote_count: 'raw_details.vote_count',
        number_of_seasons: 'raw_details.number_of_seasons',
        number_of_episodes: 'raw_details.number_of_episodes',
        original_language: 'raw_details.original_language',
        original_name: 'raw_details.original_name',
        popularity: 'raw_details.popularity',
        backdrop_path: 'raw_details.backdrop_path',
        watch_providers: 'raw_details.watch_providers',
      },
      gift_details: {
        quantity: 'quantity',
        where_to_buy: 'where_to_buy',
        amazon_url: 'amazon_url',
        web_link: 'web_link',
        rating: 'rating'
      },
      // Add other mappings here as needed
    };

    const columnMap = tableColumnMap[tableName];
    if (!columnMap) {
      logger.warn(`[ListService.createDetailRecord] No column mapping found for table: ${tableName}`);
      return null;
    }

    const record = { list_item_id: listItemId };
    
    // Add debug logging for gift_details
    if (tableName === 'gift_details') {
      logger.info(`[ListService.createDetailRecord] Processing gift_details for item ${listItemId}`);
      logger.info(`[ListService.createDetailRecord] apiMetadata:`, typeof apiMetadata === 'string' ? apiMetadata : JSON.stringify(apiMetadata));
      logger.info(`[ListService.createDetailRecord] listItemData:`, JSON.stringify(listItemData));
    }
    // --- Normalise metadata keys / shapes ---
    let metadata = typeof apiMetadata === 'string' ? JSON.parse(apiMetadata) : apiMetadata || {};

    // Alias camelCase rawDetails -> snake_case raw_details for easier mapping
    if (metadata && metadata.rawDetails && !metadata.raw_details) {
      metadata.raw_details = metadata.rawDetails;
    }
    if (metadata && metadata.raw_details && !metadata.rawDetails) {
      metadata.rawDetails = metadata.raw_details;
    }

    // Expose TMDB watch providers under a stable key for column mapping
    if (metadata && metadata.raw_details && metadata.raw_details['watch/providers'] && !metadata.raw_details.tmdb_watch_providers) {
      metadata.raw_details.tmdb_watch_providers = metadata.raw_details['watch/providers'];
    }

    // Normalize spoken_languages field from TMDB
    if (metadata && metadata.raw_details && metadata.raw_details.tmdb_spoken_languages && !metadata.raw_details.spoken_languages) {
      metadata.raw_details.spoken_languages = metadata.raw_details.tmdb_spoken_languages;
    }
    
    // If google_place_id missing but raw_details.place_id exists, set source_id for mapping
    if (!metadata.source_id) {
      const placeIdCandidate = (metadata.raw_details && metadata.raw_details.place_id) || (metadata.rawDetails && metadata.rawDetails.place_id);
      if (placeIdCandidate) {
        metadata.source_id = placeIdCandidate;
      }
    }
    
    const getNestedValue = (obj, path) => {
        if (!path) return undefined;
        return path.split('.').reduce((acc, part) => acc && acc[part], obj);
    };

    for (const [column, sourcePath] of Object.entries(columnMap)) {
      // Prioritize value from metadata (API source)
      let value = getNestedValue(metadata, sourcePath);

      // If value is not in metadata, try to get it from the base listItemData
      if ((value === undefined || value === null) && listItemData) {
        value = getNestedValue(listItemData, sourcePath);
      }

      if (value !== undefined && value !== null) {
        if (column === 'genres' && Array.isArray(value)) {
          // Map array of genre objects to an array of genre names for the text[] column
          record[column] = value.map(g => g.name).filter(Boolean);
        } else if (['production_companies', 'production_countries', 'spoken_languages'].includes(column)) {
          // Handle JSONB columns - ensure they are properly formatted JSON
          if (typeof value === 'string') {
            try {
              // If it's already a JSON string, parse and re-stringify to ensure it's valid
              const parsed = JSON.parse(value);
              record[column] = JSON.stringify(parsed);
            } catch (e) {
              // If parsing fails, wrap the string value in quotes to make it valid JSON
              logger.warn(`[ListService.createDetailRecord] Invalid JSON string for ${column}, wrapping as string:`, value);
              record[column] = JSON.stringify(value);
            }
          } else if (typeof value === 'object') {
            // If it's an object/array, stringify it
            record[column] = JSON.stringify(value);
          } else {
            // For primitive values, stringify them
            record[column] = JSON.stringify(value);
          }
        } else if (column === 'photos' && Array.isArray(value)) {
          record.photos = value
            .map(p => p?.photo_reference ?? p?.reference)
            .filter(Boolean);
        } else {
          record[column] = value;
        }
      }
    }
    
    // Always persist a detail row, even if we only have list_item_id for now.
    // Additional metadata can be backfilled later once fetched from external APIs.

    const insertColumns = Object.keys(record);
    const insertValues = Object.values(record);
    const valuePlaceholders = insertValues.map((_, i) => `$${i + 1}`).join(', ');

    // Log the final record for gift_details
    if (tableName === 'gift_details') {
      logger.info(`[ListService.createDetailRecord] Final gift_details record to insert:`, JSON.stringify(record));
      logger.info(`[ListService.createDetailRecord] Insert columns:`, insertColumns);
      logger.info(`[ListService.createDetailRecord] Insert values:`, insertValues);
    }
    
    // Build the UPDATE SET clause for ON CONFLICT
    const updateSetClause = insertColumns
      .filter(col => col !== 'list_item_id') // Don't update the primary key
      .map(col => `${col} = EXCLUDED.${col}`)
      .join(', ');
    
    const query = `INSERT INTO ${tableName} (${insertColumns.join(', ')}) VALUES (${valuePlaceholders})
                  ON CONFLICT (list_item_id)
                  DO UPDATE SET ${updateSetClause}, updated_at = CURRENT_TIMESTAMP
                  RETURNING *;`;

    try {
      const { rows } = await client.query(query, insertValues);
      return rows[0];
    } catch (err) {
      // Gracefully handle attempts to insert a duplicate google_place_id for place_details.
      // When this happens we simply fetch the existing row so the caller can link to it
      // instead of aborting the whole transaction.
      if (
        tableName === 'place_details' &&
        err?.code === '23505' &&
        (err?.constraint === 'place_details_google_place_id_key' || err?.detail?.includes('(google_place_id)'))
      ) {
        try {
          const { rows } = await client.query(
            `SELECT * FROM place_details WHERE google_place_id = $1 LIMIT 1`,
            [record.google_place_id]
          );
          if (rows.length) {
            logger.info('[ListService.createDetailRecord] Reusing existing place_details row due to duplicate google_place_id');
            return rows[0];
          }
        } catch (selectErr) {
          logger.error('[ListService.createDetailRecord] Failed to fetch existing place_details after duplicate error:', selectErr);
        }
      }
      // Re-throw if it's not the duplicate google_place_id scenario we expect to handle here.
      throw err;
    }
  }
}

module.exports = new ListService(); 