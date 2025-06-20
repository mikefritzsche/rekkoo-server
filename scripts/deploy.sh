#!/bin/bash

# Default environment variables
export SAFE_BRANCH_NAME=${SAFE_BRANCH_NAME:-main}
export HOST=${HOST:-api.rekkoo.com}
export ENTRYPOINT=${ENTRYPOINT:-websecure}
export USE_TLS=${USE_TLS:-true}

# Base compose command
COMPOSE_CMD="docker compose -f docker-compose.yml -f docker-compose.prod.yml"

# Function to check if containers are running
check_status() {
    echo "Checking container status..."
    $COMPOSE_CMD ps
}

# Function to set up environment files
setup_env() {
    echo "Setting up environment files..."
    
    # Check for environment files copied by CircleCI
    echo "Available environment files:"
    ls -la .env* 2>/dev/null || echo "No .env files found"
    
    # Verify required environment files exist
    # Docker Compose will automatically load them in the correct order
    
    if [ -f .env.common ]; then
        echo "✅ Found .env.common (shared configuration)"
        echo "📋 .env.common summary:"
        echo "  Lines: $(wc -l < .env.common)"
        echo "  Size: $(du -h .env.common | cut -f1)"
        
        # Check for Apple OAuth variables in .env.common
        APPLE_VARS=$(grep -c "^APPLE_" .env.common 2>/dev/null || echo "0")
        echo "  Apple OAuth variables: $APPLE_VARS found"
    else
        echo "⚠️  .env.common not found!"
        
        # Fallback: try parent directory (backward compatibility)
        if [ -f ../.env.common ]; then
            echo "Fallback: copying .env.common from parent directory..."
            cp ../.env.common .env.common
        else
            echo "❌ No .env.common file found. This is required for shared configuration."
            exit 1
        fi
    fi
    
    if [ -f .env ]; then
        echo "✅ Found .env (environment-specific overrides)"
        echo "📋 .env summary:"
        echo "  Lines: $(wc -l < .env)"
        echo "  Size: $(du -h .env | cut -f1)"
    else
        echo "ℹ️  No .env file found (environment-specific overrides)"
        echo "This is optional - .env.common will provide base configuration"
    fi
    
    # Show sample variables from .env.common (without values for security)
    if [ -f .env.common ]; then
        echo "📋 Sample variables from .env.common:"
        grep -E '^[A-Z_]+=.*' .env.common | head -5 | sed 's/=.*/=***/' | sed 's/^/    /'
    fi
    
    echo "✅ Environment files validated successfully"
    echo "🐳 Docker Compose will load files in this order:"
    echo "  1. .env (if present) - environment-specific variables"
    echo "  2. .env.common - shared variables (including Apple OAuth)"
}

# Function to display logs
show_logs() {
    if [ "$1" == "--follow" ] || [ "$1" == "-f" ]; then
        echo "Showing logs (follow mode)..."
        $COMPOSE_CMD logs -f
    else
        echo "Showing logs..."
        $COMPOSE_CMD logs
    fi
}

# Main command handling
case "$1" in
    "up")
        echo "Starting production environment..."
        setup_env
        $COMPOSE_CMD up -d --no-build
        check_status
        ;;

    "down")
        echo "Stopping production environment..."
        $COMPOSE_CMD down
        ;;

    "restart")
        echo "Restarting production environment..."
        $COMPOSE_CMD down
        setup_env
        $COMPOSE_CMD up -d --no-build
        check_status
        ;;

    "rebuild")
        echo "Rebuilding and starting production environment..."
        setup_env
        $COMPOSE_CMD up -d --build
        check_status
        ;;

    "logs")
        show_logs "$2"
        ;;

    "status")
        check_status
        ;;

    *)
        echo "Usage: $0 {up|down|restart|rebuild|logs|status}"
        echo
        echo "Commands:"
        echo "  up       Start the production environment"
        echo "  down     Stop the production environment"
        echo "  restart  Restart the production environment"
        echo "  rebuild  Rebuild and start the production environment"
        echo "  logs     Show container logs (use -f or --follow for following)"
        echo "  status   Check container status"
        exit 1
        ;;
esac

exit 0
