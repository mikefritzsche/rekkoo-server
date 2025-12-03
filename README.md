## Docker Usage:

- local:  docker compose --env-file=.env.common --env-file=.env.development -f docker-compose.yml -f docker-compose.override.yml up -d --build 
- docker compose --env-file=.env.common --env-file=.env.development -f docker-compose.yml -f docker-compose.override.yml down && docker compose --env-file=.env.common --env-file=.env.development -f docker-compose.yml -f docker-compose.override.yml up -d --build
- Development: docker compose up
- Production: docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

## NS check
- dig -t A api.rekkoo.com @hydrogen.ns.hetzner.com

## How to Use:

 - Development: docker compose -f docker-compose.yml -f docker-compose.override.yml up --build

 - Production: docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build -d 
 - (Ensure all required environment variables like HOST, PORT, ENTRYPOINT, USE_TLS, etc., are set in your production environment or .env file).

 ### Hetzner Volume
 -  scp /path/to/your/local/file admin@5.78.127.128:/mnt/volume-hil-1

 v0.0.6