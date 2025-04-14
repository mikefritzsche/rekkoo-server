## Docker Usage:

- local:  docker compose --env-file=.env.development --env-file=.env.common up -d
- Development: docker compose up
- Production: docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

## NS check
- dig -t A api.rekkoo.com @hydrogen.ns.hetzner.com

## How to Use:

 - Development: docker-compose -f docker-compose.yml -f docker-compose.override.yml up --build

 - Production: docker-compose -f docker-compose.yml -f docker-compose.prod.yml up --build -d 
 - (Ensure all required environment variables like HOST, PORT, ENTRYPOINT, USE_TLS, etc., are set in your production environment or .env file).