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
    
    # Priority order: .env.production > .env.staging > .env.development > .env.common > .env
    # Use the most appropriate file for the environment
    
    if [ -f .env.production ]; then
        echo "Using .env.production as primary environment file"
        cp .env.production .env
    elif [ -f .env.staging ]; then
        echo "Using .env.staging as primary environment file"
        cp .env.staging .env
    elif [ -f .env.development ]; then
        echo "Using .env.development as primary environment file"
        cp .env.development .env
    elif [ -f .env.common ]; then
        echo "Using .env.common as primary environment file"
        cp .env.common .env
    elif [ -f .env ]; then
        echo "Using existing .env file"
    else
        echo "⚠️  No environment files found!"
        echo "Expected files: .env.production, .env.staging, .env.development, .env.common, or .env"
        
        # Fallback: try parent directory (backward compatibility)
        if [ -f ../.env.common ]; then
            echo "Fallback: copying .env.common from parent directory..."
            cp ../.env.common .env
        else
            echo "❌ No environment configuration found. Deployment may fail."
            exit 1
        fi
    fi
    
    # Verify we have a working .env file
    if [ -f .env ]; then
        echo "✅ Environment file configured successfully"
        echo "📋 Environment file summary:"
        echo "  Lines: $(wc -l < .env)"
        echo "  Size: $(du -h .env | cut -f1)"
        # Show first few non-comment, non-empty lines (without values for security)
        echo "  Sample variables:"
        grep -E '^[A-Z_]+=.*' .env | head -5 | sed 's/=.*/=***/' | sed 's/^/    /'
    else
        echo "❌ Failed to set up environment file"
        exit 1
    fi
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
