# Google Cloud Deployment Guide with Cloudflare Tunnel

This variant keeps the backend closed to inbound internet traffic on GCP, while exposing it to your Cloudflare-hosted frontend through a Cloudflare Tunnel.

## Architecture

- Compute Engine VM: `e2-micro` in `asia-south1-a`
- Cloud SQL PostgreSQL: `db-f1-micro` in `asia-south1`
- Local Redis on the VM
- Cloud SQL Auth Proxy on the VM
- `cloudflared` on the VM using a remotely-managed tunnel token
- Backend published through Cloudflare Tunnel, not directly from GCP
- No inbound HTTP/HTTPS firewall rules needed on the VM
- Batches are generated manually by operators from the app UI

If `e2-micro` is too tight for Redis + workers + Python, resize the VM to `e2-small`.

## Files to use

- `deploy/docker-compose.gce-cloudsql-tunnel.yml`
- `deploy/.env.cloudsql-tunnel.example`
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

An external IP is acceptable for admin SSH access and package downloads. The app is not publicly exposed because traffic enters through Cloudflare Tunnel.

## 4. Create the Cloudflare Tunnel

In Cloudflare Zero Trust:

1. Go to `Networks > Tunnels`.
2. Create a new tunnel using `Cloudflared`.
3. Add a public hostname route for the backend.
   - This should point to `http://api:8080` inside the container network conceptually, but you only configure the hostname in Cloudflare here.
4. Copy the `cloudflared` installation command shown by Cloudflare.
5. Extract the tunnel token from that command. It is the long `eyJ...` value.

Cloudflare’s official token flow:

- [Tunnel tokens](https://developers.cloudflare.com/tunnel/advanced/tunnel-tokens/)
- [Set up Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/setup/)

## 5. Upload the project

Because this guide assumes a local ZIP workflow:

- open Cloud Shell
- upload the project ZIP
- unzip it
- move/copy it to the VM

Final path on the VM:

- `~/compliance-mvp`

## 6. Install Docker on the VM

SSH into the VM and install:

- Docker Engine
- Docker Compose plugin

Use the official Docker Ubuntu instructions for the current commands.

## 7. Create env files

Create `backend/.env.production` using `backend/.env.example`.

Required notes:

- set `FRONTEND_URL` to your Cloudflare frontend URL
- do not set `DATABASE_URL`
- do not set `REDIS_URL`
- set `WORKERS_ENABLED=true`
- set `PYTHON_SCRIPT_PATH=/app/backend/python`

Create `deploy/.env` from `deploy/.env.cloudsql-tunnel.example`:

```env
INSTANCE_CONNECTION_NAME=your-project:asia-south1:ckyc-db
CLOUDSQL_DATABASE_URL=postgresql://ckyc_app:your-db-password@cloud-sql-proxy:5432/ckyc?sslmode=disable
TUNNEL_TOKEN=your-cloudflare-tunnel-token
```

## 8. Start the tunnel stack

On the VM:

```bash
cd ~/compliance-mvp/deploy
docker compose -f docker-compose.gce-cloudsql-tunnel.yml --env-file .env up -d --build
```

These services should run:

- `api`
- `cloud-sql-proxy`
- `redis`
- `cloudflared`

## 9. Run migrations and create the first user

```bash
cd ~/compliance-mvp/deploy
docker compose -f docker-compose.gce-cloudsql-tunnel.yml exec api npm run migrate
docker compose -f docker-compose.gce-cloudsql-tunnel.yml exec api npm run create-user
```

## 10. Verify locally on the VM

```bash
curl http://127.0.0.1:8080/health
docker compose -f docker-compose.gce-cloudsql-tunnel.yml ps
docker compose -f docker-compose.gce-cloudsql-tunnel.yml logs -f api
docker compose -f docker-compose.gce-cloudsql-tunnel.yml logs -f cloudflared
```

## 11. Point the frontend to the tunnel hostname

Your Cloudflare frontend must call the tunnel hostname you configured in Zero Trust.

Set frontend API base URL to:

- `https://<your-tunnel-hostname>/api/v1`

If you do not want a user-visible separate backend hostname later, put a proxy or rewrite in front of it at the frontend layer. The tunnel itself still needs a public hostname route.

## 12. Batch operations

Batches are created manually in the frontend. After login:

- open the Batches page
- select the date range
- select the primary and secondary ops users
- generate the batch

## 13. Operator access

Default operator access method:

- SSH into the VM from the GCP Console
- use curl locally on the VM
- inspect Docker logs directly on the VM

The backend is not directly published from GCP, but it is reachable through Cloudflare Tunnel.
