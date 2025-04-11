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
    # First, get .env.common from parent directory if it doesn't exist
    if [ ! -f .env.common ]; then
        cp ../.env.common .
    fi

    # Copy main .env from parent directory, overwriting if it exists
    if [ -f ../.env ]; then
        echo "Copying .env from parent directory..."
        cp -f ../.env .
        # Ensure the copy was successful
        if [ $? -eq 0 ]; then
            echo "Successfully copied .env file"
            echo "Current .env contents:"
            cat .env
        else
            echo "Failed to copy .env file"
            exit 1
        fi
    else
        echo "No .env found in parent directory, creating from .env.common..."
        cp .env.common .env
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
