const { logger } = require('../utils/logger');
const syncOptimization = require('../config/sync-optimization');

class SyncMonitor {
  constructor() {
    this.metrics = {
      activeConnections: 0,
      requestsPerSecond: 0,
      avgResponseTime: 0,
      errorRate: 0,
      cpuUsage: 0,
      memoryUsage: 0
    };
    
    // Keep separate arrays for durations and timestamps
    this.requestTimes = [];
    this.requestTimestamps = [];
    this.errors = [];
    this.startTime = Date.now();
    this.isThrottling = false;
    
    // Start monitoring
    this.startMetricsCollection();
  }

  /**
   * Middleware for monitoring sync requests
   */
  monitor() {
    return async (req, res, next) => {
      const startTime = Date.now();
      this.metrics.activeConnections++;

      // Check if we should throttle
      if (await this.shouldThrottle(req)) {
        this.metrics.activeConnections--;
        return res.status(429).json({ 
          error: 'Server overloaded, please try again later',
          retryAfter: this.getRetryAfter()
        });
      }

      // Track request
      const originalSend = res.send;
      const self = this;
      res.send = function(data) {
        const endTime = Date.now();
        const responseTime = endTime - startTime;
        
        // Record metrics
        self.requestTimes.push(responseTime);
        if (self.requestTimes.length > 100) {
          self.requestTimes.shift();
        }
        // Record timestamp of completed request for RPS calculation
        self.requestTimestamps.push(endTime);
        if (self.requestTimestamps.length > 1000) {
          self.requestTimestamps = self.requestTimestamps.slice(-1000);
        }
        
        self.metrics.activeConnections--;
        self.metrics.avgResponseTime = self.requestTimes.reduce((a, b) => a + b, 0) / self.requestTimes.length;
        
        // Log slow requests
        if (responseTime > 5000) {
          logger.warn(`[SyncMonitor] Slow sync request: ${req.path} took ${responseTime}ms`);
        }
        
        originalSend.call(this, data);
      };

      // Track errors
      res.on('error', (error) => {
        self.errors.push(Date.now());
        logger.error('[SyncMonitor] Sync request error:', error);
      });

      next();
    };
  }

  /**
   * Determine if requests should be throttled
   */
  async shouldThrottle(req) {
    // Allow disabling throttling in local development or via env flag
    if (process.env.DISABLE_SYNC_THROTTLE === 'true' || process.env.NODE_ENV === 'development') {
      this.isThrottling = false;
      return false;
    }
    const userId = req.user?.id;
    
    // Check rate limiting per user
    if (userId && await syncOptimization.isRateLimited(userId, 30, 60000)) {
      logger.warn(`[SyncMonitor] Rate limiting user ${userId}`);
      return true;
    }

    // Check system load
    if (this.metrics.activeConnections > 500) {
      this.isThrottling = true;
      logger.warn('[SyncMonitor] Throttling due to high active connections');
      return true;
    }

    // Only throttle on high response time if there is some concurrent activity
    if (this.metrics.avgResponseTime > 10000 && (this.metrics.activeConnections > 10 || this.metrics.requestsPerSecond > 2)) {
      this.isThrottling = true;
      logger.warn('[SyncMonitor] Throttling due to high response times');
      return true;
    }

    if (this.metrics.errorRate > 0.1) {
      this.isThrottling = true;
      logger.warn('[SyncMonitor] Throttling due to high error rate');
      return true;
    }

    // Check if user has made too many recent requests
    if (userId && await syncOptimization.hasRecentSyncActivity(userId, 5000)) {
      logger.info(`[SyncMonitor] Throttling user ${userId} for frequent requests`);
      return true;
    }

    this.isThrottling = false;
    return false;
  }

  /**
   * Calculate retry-after header value
   */
  getRetryAfter() {
    if (this.metrics.activeConnections > 1000) return 120; // 2 minutes
    if (this.metrics.activeConnections > 500) return 60;   // 1 minute
    if (this.metrics.avgResponseTime > 10000) return 30;   // 30 seconds
    return 15; // 15 seconds default
  }

  /**
   * Start collecting system metrics
   */
  startMetricsCollection() {
    setInterval(() => {
      this.collectSystemMetrics();
      this.calculateErrorRate();
      this.logMetrics();
    }, 30000); // Every 30 seconds
  }

  /**
   * Collect system performance metrics
   */
  collectSystemMetrics() {
    const usage = process.cpuUsage();
    const memUsage = process.memoryUsage();
    
    this.metrics.cpuUsage = (usage.user + usage.system) / 1000000; // Convert to seconds
    this.metrics.memoryUsage = memUsage.heapUsed / 1024 / 1024; // Convert to MB
    
    // Calculate requests per second
    const now = Date.now();
    // Use timestamps, not durations
    this.requestTimestamps = this.requestTimestamps.filter(ts => now - ts < 60000);
    this.metrics.requestsPerSecond = this.requestTimestamps.length / 60;
  }

  /**
   * Calculate error rate
   */
  calculateErrorRate() {
    const now = Date.now();
    const recentErrors = this.errors.filter(time => now - time < 300000); // Last 5 minutes
    const totalRequests = this.requestTimes.length;
    
    this.metrics.errorRate = totalRequests > 0 ? recentErrors.length / totalRequests : 0;
    
    // Clean old errors
    this.errors = this.errors.filter(time => now - time < 300000);
  }

  /**
   * Log current metrics
   */
  logMetrics() {
    if (this.isThrottling || this.metrics.activeConnections > 100) {
      logger.info('[SyncMonitor] Current metrics:', {
        activeConnections: this.metrics.activeConnections,
        requestsPerSecond: this.metrics.requestsPerSecond.toFixed(2),
        avgResponseTime: `${this.metrics.avgResponseTime.toFixed(0)}ms`,
        errorRate: `${(this.metrics.errorRate * 100).toFixed(2)}%`,
        memoryUsage: `${this.metrics.memoryUsage.toFixed(0)}MB`,
        isThrottling: this.isThrottling
      });
    }
  }

  /**
   * Get current metrics for API
   */
  getMetrics() {
    return {
      ...this.metrics,
      uptime: Date.now() - this.startTime,
      isThrottling: this.isThrottling,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Health check endpoint data
   */
  getHealthStatus() {
    const status = {
      status: 'healthy',
      metrics: this.getMetrics(),
      optimization: syncOptimization.getStats()
    };

    if (this.metrics.activeConnections > 800) {
      status.status = 'degraded';
      status.reason = 'High connection count';
    } else if (this.metrics.avgResponseTime > 15000) {
      status.status = 'degraded';
      status.reason = 'High response times';
    } else if (this.metrics.errorRate > 0.15) {
      status.status = 'unhealthy';
      status.reason = 'High error rate';
    }

    return status;
  }
}

module.exports = new SyncMonitor(); 