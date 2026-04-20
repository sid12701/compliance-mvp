# Google Cloud Internal Deployment Guide

This variant keeps the backend private inside a Mumbai VM and uses Cloud SQL in Mumbai, while continuing to store files in Cloudflare R2.

## Architecture

- Compute Engine VM: `e2-micro` in `asia-south1-a`
- Cloud SQL PostgreSQL: `db-f1-micro` in `asia-south1`
- Local Redis on the VM
- Cloud SQL Auth Proxy on the VM
- Backend bound to `127.0.0.1:8080` only
- No public domain, no public HTTPS, no Cloud Scheduler
- Batches are generated manually by operators from the app UI

If `e2-micro` is too tight for Redis + workers + Python, resize the VM to `e2-small`.

## Files to use

- `deploy/docker-compose.gce-cloudsql-internal.yml`
- `deploy/.env.cloudsql-internal.example`
- `backend/Dockerfile`

## 1. Create Cloud SQL in Mumbai

In the Google Cloud Console:

- SQL > Create instance > PostgreSQL
- Version: `PostgreSQL 15`
- Tier: `db-f1-micro`
- Region: `asia-south1`
- Availability: zonal
- Storage: SSD, 10 GB
- Public IP: enabled
- Automatic backups: enabled

Then create:

- database: `ckyc`
- user: `ckyc_app`

Record the instance connection name and DB password.

## 2. Create the service account key

In `IAM & Admin > Service Accounts`:

- create `ckyc-cloudsql-client`
- grant `Cloud SQL Client`
- create and download a JSON key

Place the key on the VM as:

- `deploy/gcp-service-account.json`

## 3. Create the VM

In `Compute Engine > VM instances > Create instance`:

- Name: `ckyc-api`
- Region: `asia-south1`
- Zone: `asia-south1-a`
- Machine type: `e2-micro`
- Boot disk: Ubuntu 24.04 LTS, `20 GB`, `pd-balanced`
- Do not enable HTTP
- Do not enable HTTPS

An external IP is acceptable for admin SSH access. The app still remains private because it only binds to loopback.

## 4. Upload the project

Because this guide assumes a local ZIP workflow:

- open Cloud Shell
- upload the project ZIP
- unzip it
- move/copy it to the VM

Final path on the VM:

- `~/compliance-mvp`

## 5. Install Docker on the VM

SSH into the VM and install:

- Docker Engine
- Docker Compose plugin

Use the official Docker Ubuntu instructions for the current commands.

## 6. Create env files

Create `backend/.env.production` using `backend/.env.example`.

Required notes:

- set `FRONTEND_URL` to a placeholder internal value if no frontend uses this deployment
- do not set `DATABASE_URL`
- do not set `REDIS_URL`
- set `WORKERS_ENABLED=true`
- set `PYTHON_SCRIPT_PATH=/app/backend/python`

Create `deploy/.env` from `deploy/.env.cloudsql-internal.example`:

```env
INSTANCE_CONNECTION_NAME=your-project:asia-south1:ckyc-db
CLOUDSQL_DATABASE_URL=postgresql://ckyc_app:your-db-password@cloud-sql-proxy:5432/ckyc?sslmode=disable
```

## 7. Start the internal stack

On the VM:

```bash
cd ~/compliance-mvp/deploy
docker compose -f docker-compose.gce-cloudsql-internal.yml --env-file .env up -d --build
```

Only these services should run:

- `api`
- `cloud-sql-proxy`
- `redis`

## 8. Run migrations and create the first user

```bash
cd ~/compliance-mvp/deploy
docker compose -f docker-compose.gce-cloudsql-internal.yml exec api npm run migrate
docker compose -f docker-compose.gce-cloudsql-internal.yml exec api npm run create-user
```

## 9. Verify locally on the VM

```bash
curl http://127.0.0.1:8080/health
docker compose -f docker-compose.gce-cloudsql-internal.yml ps
docker compose -f docker-compose.gce-cloudsql-internal.yml logs -f api
```

The API should not be reachable publicly because:

- no HTTP/HTTPS firewall rules are open
- the container only binds to `127.0.0.1`

## 10. Batch operations

Batches are created manually in the frontend. After login:

- open the Batches page
- select the date range
- select the primary and secondary ops users
- generate the batch

## 11. Operator access

Default access method:

- SSH into the VM from the GCP Console
- use curl locally on the VM
- optionally use SSH port forwarding if browser access is ever needed

No public backend URL is created in this variant.
