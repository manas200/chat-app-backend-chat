import { redisClient } from "../index.js";

/**
 * CacheService - A reusable caching utility
 *
 * Provides methods for:
 * - get: Retrieve cached data
 * - set: Store data with TTL
 * - invalidate: Delete specific cache key
 * - invalidatePattern: Delete multiple keys matching a pattern
 */
class CacheService {
  /**
   * Check if Redis is connected and available
   */
  private isAvailable(): boolean {
    return redisClient && redisClient.isOpen;
  }

  /**
   * Get cached data by key
   * @param key - Cache key
   * @returns Parsed data or null if not found
   */
  async get<T>(key: string): Promise<T | null> {
    if (!this.isAvailable()) {
      console.log("⚠️ Redis not available, skipping cache get");
      return null;
    }

    try {
      const cached = await redisClient.get(key);
      if (!cached) return null;

      console.log(`📦 Cache HIT: ${key}`);
      return JSON.parse(cached) as T;
    } catch (error) {
      console.error(`❌ Cache get error for ${key}:`, error);
      return null;
    }
  }

  /**
   * Store data in cache with TTL
   * @param key - Cache key
   * @param value - Data to cache (will be JSON stringified)
   * @param ttl - Time to live in seconds (default: 60)
   */
  async set(key: string, value: unknown, ttl: number = 60): Promise<void> {
    if (!this.isAvailable()) {
      console.log("⚠️ Redis not available, skipping cache set");
      return;
    }

    try {
      await redisClient.setEx(key, ttl, JSON.stringify(value));
      console.log(`💾 Cache SET: ${key} (TTL: ${ttl}s)`);
    } catch (error) {
      console.error(`❌ Cache set error for ${key}:`, error);
    }
  }

  /**
   * Delete a specific cache key
   * @param key - Cache key to delete
   */
  async invalidate(key: string): Promise<void> {
    if (!this.isAvailable()) {
      console.log("⚠️ Redis not available, skipping cache invalidate");
      return;
    }

    try {
      await redisClient.del(key);
      console.log(`🗑️ Cache INVALIDATED: ${key}`);
    } catch (error) {
      console.error(`❌ Cache invalidate error for ${key}:`, error);
    }
  }

  /**
   * Delete multiple cache keys matching a pattern
   * @param pattern - Pattern to match (e.g., "chats:*")
   */
  async invalidatePattern(pattern: string): Promise<void> {
    if (!this.isAvailable()) {
      console.log("⚠️ Redis not available, skipping pattern invalidate");
      return;
    }

    try {
      const keys = await redisClient.keys(pattern);
      if (keys.length > 0) {
        await redisClient.del(keys);
        console.log(
          `🗑️ Cache INVALIDATED pattern: ${pattern} (${keys.length} keys)`
        );
      }
    } catch (error) {
      console.error(`❌ Cache pattern invalidate error for ${pattern}:`, error);
    }
  }

  /**
   * Generate cache key for user's chats
   * @param userId - User ID
   */
  getChatsCacheKey(userId: string): string {
    return `chats:user:${userId}`;
  }

  /**
   * Generate cache key for all users list
   */
  getAllUsersCacheKey(): string {
    return `users:all`;
  }

  /**
   * Generate cache key for a specific user
   * @param userId - User ID
   */
  getUserCacheKey(userId: string): string {
    return `user:${userId}`;
  }

  /**
   * Generate cache key for chat messages
   * @param chatId - Chat ID
   * @param page - Page number (optional, for pagination)
   */
  getMessagesCacheKey(chatId: string, page?: number): string {
    return page ? `messages:${chatId}:page:${page}` : `messages:${chatId}`;
  }

  /**
   * Invalidate all message cache for a chat
   * @param chatId - Chat ID
   */
  async invalidateMessagesCache(chatId: string): Promise<void> {
    await this.invalidatePattern(`messages:${chatId}*`);
  }
}

// Export singleton instance
export const cacheService = new CacheService();
export default cacheService;
