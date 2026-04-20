# Google Cloud Deployment Guide

This repository is cheapest to run on Google Cloud as a single small Compute Engine VM, not Cloud Run.

If you are already using hosted PostgreSQL and Redis outside GCP, the absolute cheapest variant is even smaller: keep those external services and run only the backend on Compute Engine.

## Recommended shape

- Compute Engine VM: `e2-small` on Ubuntu 24.04 LTS
- Disk: `pd-balanced`, 20 to 30 GB
- Region:
  - `asia-south1` if your operators are mostly in India
  - `us-central1` if you want the lowest-cost general region
- On the VM:
  - backend API container
  - BullMQ workers in the same container with `WORKERS_ENABLED=true`
  - local PostgreSQL container
  - local Redis container
  - Caddy for HTTPS
- Keep using Cloudflare R2 for object storage
- Batches are created manually by operators in the frontend

## Even cheaper hybrid variant

If you already have working Supabase and Upstash credentials:

- use a backend-only VM
- keep `DATABASE_URL` pointing to Supabase
- keep `REDIS_URL` pointing to Upstash
- keep R2 on Cloudflare
- start with `e2-micro` if memory stays stable, otherwise move to `e2-small`

That is usually the lowest monthly cost if you are comfortable keeping a multi-provider setup.

## Why this is the cheapest practical option for this codebase

Your backend is not just an HTTP API:

- it runs BullMQ workers
- it depends on Redis
- it spawns Python processes for CKYC generation and response analysis
- operators trigger batches manually from the app

Cloud Run is possible, but it stops being the cheapest clean option here because:

- Cloud Run only bills CPU during requests by default, which is awkward for background worker-style processing
- keeping minimum instances warm adds idle charges
- using private Redis from Cloud Run often means Serverless VPC Access, and Google bills the connector like Compute Engine VMs
- Cloud SQL and Memorystore are always-on managed services, which dominate cost for a workload this small

For this MVP, one VM is the right tradeoff.

## Rough monthly cost shape

This is a planning estimate, not a quote:

- Compute Engine `e2-small`: usually the core monthly cost bucket
- Persistent disk 20 to 30 GB: small add-on
- Static IP: free while attached to a running VM
- no scheduler cost is required because batches are manual

This is usually much cheaper than:

- Cloud Run with a warm instance for workers
- Cloud SQL
- Memorystore
- Serverless VPC Access

## Files added in this repo

- `backend/Dockerfile`
- `backend/requirements.txt`
- `deploy/docker-compose.gce.yml`
- `deploy/docker-compose.gce-backend-only.yml`
- `deploy/docker-compose.gce-cloudsql.yml`
- `deploy/docker-compose.gce-cloudsql-internal.yml`
- `deploy/docker-compose.gce-cloudsql-tunnel.yml`
- `deploy/Caddyfile`

If you want the backend to stay internal-only with Cloud SQL in GCP and no domain:

- use `deploy/docker-compose.gce-cloudsql-internal.yml`
- use `docs/google-cloud-deploy-internal.md`

If the frontend is on Cloudflare and the backend should be reachable without opening inbound ports on GCP:

- use `deploy/docker-compose.gce-cloudsql-tunnel.yml`
- use `docs/google-cloud-deploy-cloudflare-tunnel.md`

## 1. Create the VM

Create one VM in the Google Cloud Console or with `gcloud`.

Recommended settings:

- Machine type: `e2-small`
- Boot disk: Ubuntu 24.04 LTS
- Disk size: 20 GB minimum
- Firewall: allow HTTP and HTTPS
- Reserve a static external IP

If you expect heavier upload-generation batches later, move to `e2-medium`.

## 2. Install Docker on the VM

SSH into the VM and run:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker $USER
newgrp docker
```

## 3. Copy the repo to the VM

Any of these is fine:

- `git clone`
- `scp -r`
- GitHub Actions or Cloud Build later

Example:

```bash
git clone <your-repo-url> app
cd app
```

## 4. Create production env files

Create `backend/.env.production` from `backend/.env.example`.

Important values:

```env
NODE_ENV=production
PORT=8080

JWT_SECRET=<long-random-secret>
JWT_EXPIRY=8h

R2_ACCOUNT_ID=<cloudflare-account-id>
R2_ACCESS_KEY_ID=<r2-key>
R2_SECRET_ACCESS_KEY=<r2-secret>
R2_BUCKET_NAME=<your-r2-bucket>
R2_PUBLIC_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com

RESEND_API_KEY=<resend-key>
EMAIL_FROM_ADDRESS=<verified-sender>
EMAIL_OPS_RECIPIENT=<ops-email>

GMAIL_ADDRESS=<gmail-address>
GMAIL_APP_PASSWORD=<gmail-app-password>

PYTHON_SCRIPT_PATH=/app/backend/python
PYTHON_TIMEOUT_MS=30000

FRONTEND_URL=https://<your-frontend-domain>

WORKERS_ENABLED=true
```

Variant rules:

- if you use `deploy/docker-compose.gce.yml`, do not set `DATABASE_URL` or `REDIS_URL` in `backend/.env.production`
- if you use `deploy/docker-compose.gce-backend-only.yml`, set both `DATABASE_URL` and `REDIS_URL` in `backend/.env.production`
- if you use `deploy/docker-compose.gce-cloudsql.yml`, do not set `DATABASE_URL` in `backend/.env.production`; Compose injects the Cloud SQL proxy connection string

Create `deploy/.env`:

```env
POSTGRES_PASSWORD=<strong-postgres-password>
API_DOMAIN=api.<your-domain>
```

For the Cloud SQL variant, use this instead:

```env
API_DOMAIN=api.<your-domain>
INSTANCE_CONNECTION_NAME=<gcp-project>:<region>:<cloudsql-instance>
CLOUDSQL_DATABASE_URL=postgresql://<db-user>:<db-password>@cloud-sql-proxy:5432/<db-name>?sslmode=disable
```

Also place a Cloud SQL client service-account key at:

`deploy/gcp-service-account.json`

That service account needs at least the `Cloud SQL Client` role.

## 5. Start the stack

From the repo root on the VM:

```bash
cd deploy
docker compose -f docker-compose.gce.yml --env-file .env up -d --build
```

If you are keeping Supabase and Upstash:

```bash
cd deploy
docker compose -f docker-compose.gce-backend-only.yml --env-file .env up -d --build
```

If you are using Cloud SQL:

```bash
cd deploy
docker compose -f docker-compose.gce-cloudsql.yml --env-file .env up -d --build
```

Then verify:

```bash
docker compose -f docker-compose.gce.yml ps
curl http://127.0.0.1:8080/health
```

For the backend-only variant:

```bash
docker compose -f docker-compose.gce-backend-only.yml ps
curl http://127.0.0.1:8080/health
```

For the Cloud SQL variant:

```bash
docker compose -f docker-compose.gce-cloudsql.yml ps
curl http://127.0.0.1:8080/health
```

## 6. Run database migrations

Once containers are up:

```bash
cd deploy
docker compose -f docker-compose.gce.yml exec api npm run migrate
```

Backend-only variant:

```bash
cd deploy
docker compose -f docker-compose.gce-backend-only.yml exec api npm run migrate
```

Cloud SQL variant:

```bash
cd deploy
docker compose -f docker-compose.gce-cloudsql.yml exec api npm run migrate
```

If you need the first admin user:

```bash
docker compose -f docker-compose.gce.yml exec api npm run create-user
```

Backend-only variant:

```bash
docker compose -f docker-compose.gce-backend-only.yml exec api npm run create-user
```

Cloud SQL variant:

```bash
docker compose -f docker-compose.gce-cloudsql.yml exec api npm run create-user
```

## 7. Point your domain to the VM

Create an `A` record for `api.<your-domain>` pointing to the VM static IP.

Caddy will automatically provision TLS once DNS resolves.

## 8. Batch creation

Batches are user-triggered from the application UI.

After deployment:

- create at least two active operator users
- open the Batches page in the frontend
- choose the date range plus primary and secondary ops users
- generate the batch manually

## 9. Frontend deployment

Your frontend is a static Vite app, so keep it separate from the VM.

Lowest-friction options:

- Cloudflare Pages
- Firebase Hosting
- Google Cloud Storage + Cloud CDN

Set:

- frontend `VITE_API_URL=https://api.<your-domain>/api/v1`
- backend `FRONTEND_URL=https://<your-frontend-domain>`

## 10. Operations checklist

- enable automatic restart: already handled by `restart: unless-stopped`
- take VM snapshots before major upgrades
- back up PostgreSQL daily with `pg_dump`
- keep only ports `80` and `443` open publicly
- do not expose `5432` or `6379`
- monitor `docker stats`, VM memory, and disk fill

## 11. Upgrade path later

If usage grows, move in this order:

1. Keep the same VM shape, increase to `e2-medium`
2. Move PostgreSQL to Cloud SQL
3. Move Redis to external Redis
4. Only then consider splitting API and workers

## 12. If you still want Cloud Run

Use Cloud Run only if you are willing to change the deployment model:

- run a dedicated always-on worker process
- use external Redis
- use external Postgres or Cloud SQL
- accept the extra cost of warm instances and networking

With the code as it exists today, Compute Engine is the simpler and cheaper production path.
