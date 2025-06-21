const environmentSchema = require('./environment-schema');

class EnvironmentConfig {
  constructor() {
    this.config = {};
    this.errors = [];
    this.warnings = [];
    this.environment = process.env.NODE_ENV || 'development';
    
    this.loadAndValidate();
  }

  loadAndValidate() {
    console.log(`🔧 Loading environment configuration for: ${this.environment}`);
    
    // Load environment variables based on schema
    for (const [key, schema] of Object.entries(environmentSchema)) {
      const value = this.loadVariable(key, schema);
      
      if (value !== undefined) {
        this.config[key] = value;
      }
    }

    // Report any issues
    this.reportIssues();
    
    // Fail fast if there are critical errors
    if (this.errors.length > 0) {
      console.error('❌ Environment configuration errors detected:');
      this.errors.forEach(error => console.error(`  - ${error}`));
      process.exit(1);
    }

    if (this.warnings.length > 0) {
      console.warn('⚠️  Environment configuration warnings:');
      this.warnings.forEach(warning => console.warn(`  - ${warning}`));
    }

    console.log('✅ Environment configuration loaded successfully');
  }

  loadVariable(key, schema) {
    let value = process.env[key];

    // Check for file-based secrets (Docker-style file mounting)
    const fileKey = `${key}_FILE`;
    if (process.env[fileKey] && !value) {
      try {
        const fs = require('fs');
        value = fs.readFileSync(process.env[fileKey], 'utf8').trim();
        console.log(`📁 Loaded ${key} from file: ${process.env[fileKey]}`);
      } catch (error) {
        if (this.isRequired(schema)) {
          this.errors.push(`Failed to read secret file for ${key}: ${error.message}`);
        } else {
          this.warnings.push(`Failed to read optional secret file for ${key}: ${error.message}`);
        }
      }
    }

    // Apply defaults if value is missing
    if (value === undefined && schema.default !== undefined) {
      value = schema.default;
      this.warnings.push(`Using default value for ${key}`);
    }

    // Check if required for this environment
    if (this.isRequired(schema)) {
      if (value === undefined || value === '') {
        this.errors.push(`Missing required environment variable: ${key}`);
        return undefined;
      }
    }

    // Skip validation if value is undefined and not required
    if (value === undefined) {
      return undefined;
    }

    // Type conversion and validation
    return this.validateAndConvert(key, value, schema);
  }

  isRequired(schema) {
    if (typeof schema.required === 'boolean') {
      return schema.required;
    }
    
    if (Array.isArray(schema.required)) {
      return schema.required.includes(this.environment);
    }
    
    return false;
  }

  validateAndConvert(key, value, schema) {
    // Handle multiline values (like private keys)
    if (schema.multiline && typeof value === 'string') {
      value = value.replace(/\\n/g, '\n');
    }

    // Type conversion
    switch (schema.type) {
      case 'number':
        const num = Number(value);
        if (isNaN(num)) {
          this.errors.push(`${key} must be a number, got: ${value}`);
          return undefined;
        }
        return num;
        
      case 'boolean':
        return value === 'true' || value === '1';
        
      case 'string':
        // Enum validation
        if (schema.enum && !schema.enum.includes(value)) {
          this.errors.push(`${key} must be one of: ${schema.enum.join(', ')}, got: ${value}`);
          return undefined;
        }
        
        // Length validation
        if (schema.minLength && value.length < schema.minLength) {
          this.errors.push(`${key} must be at least ${schema.minLength} characters long`);
          return undefined;
        }
        
        return value;
        
      default:
        return value;
    }
  }

  reportIssues() {
    // Log sensitive variables without exposing values
    const sensitiveVars = Object.entries(environmentSchema)
      .filter(([, schema]) => schema.sensitive)
      .map(([key]) => key);

    console.log('🔐 Sensitive variables configured:', 
      sensitiveVars.filter(key => this.config[key]).length + '/' + sensitiveVars.length);
  }

  get(key) {
    return this.config[key];
  }

  getAll() {
    return { ...this.config };
  }

  // Get configuration for specific service
  getAppleOAuth() {
    return {
      clientID: this.get('APPLE_CLIENT_ID'),
      teamID: this.get('APPLE_TEAM_ID'),
      keyID: this.get('APPLE_KEY_ID'),
      privateKeyString: this.get('APPLE_PRIVATE_KEY'),
      callbackURL: this.get('APPLE_CALLBACK_URL')
    };
  }

  getDatabase() {
    return {
      host: this.get('DB_HOST'),
      port: this.get('DB_PORT'),
      database: this.get('DB_NAME'),
      user: this.get('DB_USER'),
      password: this.get('DB_PASSWORD')
    };
  }

  getAIService() {
    return {
      localUrl: this.get('AI_SERVER_URL_LOCAL'),
      remoteUrl: this.get('AI_SERVER_URL_REMOTE'),
      environment: this.get('AI_SERVER_ENV')
    };
  }
}

// Create singleton instance
const envConfig = new EnvironmentConfig();

module.exports = envConfig; 