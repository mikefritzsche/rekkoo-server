# Upstash Redis Keep-Alive Solution

## Overview

This document outlines the engineering design and implementation strategy for preventing automatic shutdown of Upstash Redis free tier services by implementing a periodic keep-alive mechanism.

## Problem Statement

Upstash Redis free tier automatically shuts down after periods of inactivity. To maintain service availability, we need to implement a lightweight solution that periodically touches the Redis service to prevent automatic shutdown.

## Current Architecture Analysis

### Existing Redis Configuration
- **Client**: ioredis library
- **Connection**: Uses `VALKEY_URL` environment variable
- **Implementation**: `src/utils/cache.js` provides caching utilities
- **Pattern**: Connection string fallback to local Redis if VALKEY_URL not set

### Current Usage
- Cache layer for external API responses (Spotify, TMDB, etc.)
- Session storage and performance optimization
- TTL-based cache expiration

## Proposed Solution

### 1. Keep-Alive Script Design

#### Script Location
`scripts/upstash-keepalive.js`

#### Core Functionality
- Perform minimal Redis operation (PING command)
- Use existing ioredis configuration pattern
- Environment-based configuration
- Comprehensive error handling and logging

#### Implementation Pattern
```javascript
// Follows existing pattern from src/utils/cache.js
import Redis from 'ioredis';

const redis = new Redis(process.env.UPSTASH_REDIS_URL || process.env.VALKEY_URL);

async function keepAlive() {
  try {
    const result = await redis.ping();
    console.log(`[${new Date().toISOString()}] Upstash Redis keep-alive: ${result}`);
    return true;
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Keep-alive failed:`, error.message);
    return false;
  } finally {
    await redis.disconnect();
  }
}
```

### 2. Configuration Strategy

#### Environment Variables
- `UPSTASH_REDIS_URL`: Primary Upstash Redis connection string
- `KEEPALIVE_INTERVAL`: Interval in hours (default: 6)
- `KEEPALIVE_ENABLED`: Enable/disable flag (default: true)

#### Connection Priority
1. `UPSTASH_REDIS_URL` (production Upstash)
2. `VALKEY_URL` (fallback to existing config)
3. Local Redis (development fallback)

### 3. Scheduling Options

#### Option A: Cron Job (Recommended for Server Deployment)
```bash
# Run every 6 hours
0 */6 * * * cd /path/to/server && node scripts/upstash-keepalive.js
```

#### Option B: GitHub Actions (Recommended for Cloud Automation)
```yaml
name: Upstash Redis Keep-Alive
on:
  schedule:
    - cron: '0 */6 * * *'  # Every 6 hours
  workflow_dispatch:       # Manual trigger

jobs:
  keepalive:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '18'
      - run: npm ci
      - run: node scripts/upstash-keepalive.js
        env:
          UPSTASH_REDIS_URL: ${{ secrets.UPSTASH_REDIS_URL }}
```

#### Option C: Docker Cron (For Containerized Environments)
```dockerfile
# Add to existing Dockerfile
RUN echo "0 */6 * * * cd /app && node scripts/upstash-keepalive.js" | crontab -
```

#### Option D: Node.js Scheduler (Integrated Solution)
```javascript
// Optional: Integrate into main application
import cron from 'node-cron';

if (process.env.NODE_ENV === 'production' && process.env.UPSTASH_REDIS_URL) {
  cron.schedule('0 */6 * * *', () => {
    // Run keep-alive
  });
}
```

### 4. Security Considerations

#### Credential Management
- Store Upstash Redis URL in environment variables
- Never commit credentials to version control
- Use separate credentials for production vs. development
- Consider using encrypted environment variable storage

#### Access Control
- Limit script permissions to Redis operations only
- Use read-only Redis user if possible
- Implement connection timeouts and retry limits

### 5. Monitoring and Observability

#### Logging Strategy
- Timestamp all operations
- Log successful pings and failures
- Include connection details (without credentials)
- Structured logging for parsing

#### Health Monitoring
- Optional webhook notifications for failures
- Integration with existing monitoring systems
- Metrics collection for uptime tracking

#### Example Log Output
```
[2025-09-18T12:00:00.000Z] Upstash Redis keep-alive: PONG
[2025-09-18T18:00:00.000Z] Upstash Redis keep-alive: PONG
[2025-09-19T00:00:00.000Z] Keep-alive failed: Connection timeout
```

### 6. Testing Strategy

#### Unit Tests
- Mock Redis connections
- Test error handling scenarios
- Validate environment variable handling

#### Integration Tests
- Test actual Redis connectivity
- Validate different connection string formats
- Test timeout and retry behavior

#### Manual Testing
- Verify script execution in different environments
- Test scheduling mechanisms
- Validate monitoring and alerting

### 7. Deployment Strategy

#### Development Environment
- Use local Redis or development Upstash instance
- Manual script execution for testing
- Environment variable validation

#### Staging Environment
- Use staging Upstash Redis instance
- Automated testing of scheduling mechanisms
- Monitoring system integration testing

#### Production Environment
- Production Upstash Redis connection
- Automated scheduling deployment
- Full monitoring and alerting setup

### 8. Maintenance Considerations

#### Script Updates
- Version control for script changes
- Backward compatibility with existing environment setup
- Update scheduling configurations as needed

#### Monitoring
- Regular review of keep-alive logs
- Performance impact assessment
- Upstash service status monitoring

#### Troubleshooting
- Connection failure diagnostics
- Environment variable validation
- Scheduling mechanism verification

## Implementation Timeline

1. **Phase 1**: Script development and local testing
2. **Phase 2**: Environment configuration and deployment strategy
3. **Phase 3**: Scheduling implementation and monitoring setup
4. **Phase 4**: Production deployment and validation

## Success Criteria

- Upstash Redis service remains active during inactive periods
- Minimal resource consumption (< 1 second execution time)
- Reliable scheduling with 99%+ success rate
- Comprehensive logging for troubleshooting
- Zero impact on existing application functionality

## Risk Mitigation

- **Connection failures**: Retry logic with exponential backoff
- **Environment issues**: Fallback configuration options
- **Scheduling failures**: Multiple scheduling mechanisms
- **Security concerns**: Encrypted credential storage and minimal permissions