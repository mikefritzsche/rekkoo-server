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
}

module.exports = new ListService(); 