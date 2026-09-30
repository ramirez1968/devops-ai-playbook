# Issues Faced During Implementation

## Infrastructure

### 1. Node Group Pod Capacity Issue

- **Problem**: While creating the node group via `t3.medium`, it worked initially as there was no monitoring and ArgoCD setup done initially. When the replicas of microservices app were increased, the error faced was "too many resources, too many pods, no new claims to deallocate".

- **Root Cause**: The `t3.medium` (specs: 2 vCPU, 4 GB RAM) instance type can only have the capacity of 17 pods. Since the default namespace already has pods and the replica count was 2 of each service, the "too many pods" error occurred.

- **Solution**: Upgraded the instance type to `t3.large` (specs: 2 vCPU, 8 GB RAM) which has a capacity of 35 pods.

### 2. EBS Volume Permission Issue

- **Problem**: While attaching the EBS volume, there was a permission issue.

- **Root Cause**: Kubernetes version greater than 1.32 in AWS EKS requires the IRSA (IAM Roles for Service Accounts) policy to be attached. IAM alone cannot handle the EBS attach to EKS.

- **Solution**: Configured IRSA policy for the EBS CSI driver.

### 3. Terraform Apply Fails With `Unauthorized` on Kubernetes Resources

- **Problem**: `terraform apply` created the VPC, EKS cluster, node group, and EBS add-on (28/32), then failed on the `argocd` and `monitoring` namespaces with `Error: Unauthorized`.

- **Root Cause**: The Kubernetes and Helm providers used a token from `data "aws_eks_cluster_auth"`, which is fetched once when the plan is made. EKS tokens expire after 15 minutes, and creating the cluster plus the EBS add-on took about 18, so the token was stale by the time Terraform reached the in-cluster resources.

- **Solution**: Switched both providers in `main.tf` to `exec` authentication (`aws eks get-token`), which fetches a fresh token on every connection. A second apply created the remaining 4 resources.

---

## Database Issue

### 1. StatefulSet Init Script Failure

- **Problem**: Even though the StatefulSet was attached with an init script which had a DB dump in it, it was still failing to initialize. It was skipping the DB initializing resulting in "products page not found".

- **Root Cause**: The EBS has a folder by default named lost+found , so Postgres was considering that as the volume is not empty and it was skipping the initialisation resulting in the products pod running smoothly but when checking the logs, it was showing the product_db doesn't exist. 

- **Solution**: Created a DB-restore Job to add the DB. The correct step is to apply the DB-restore Job after the PostgreSQL pod is up and running.
- **Steps to Fix**:
  1. Wait for the PostgreSQL pod to be up and running
  2. Apply the DB-restore Job
  3. If the Job fails initially, delete the DB-restore Job and reapply it after the PostgreSQL pod is ready

---

## Monitoring

### 1. Boutique Application Metrics Not Found

- **Problem**: Even though the metrics of the cluster and node were obtained, the Boutique Application Metrics were not available. While running it via docker compose, it was showing the metrics properly. 

- **Root Cause**: The ServiceMonitor was configured with the path as `/metrics` but the application metrics were not being scraped properly.

- **Solution**: Added a ServiceMonitor with the correct path (`/metrics`) and updated the service file of the gateway so that the Grafana dashboard can have the data of the application with source as Prometheus.

---

## Local Testing (Fixed)

Found while testing the Docker Compose stack one service at a time (2026-09-29).

### 1. Frontend Returns 403 on a Fresh Clone

- **Problem**: http://localhost:3000 returned `403 Forbidden`.
- **Root Cause**: Compose ran plain `nginx:alpine` serving `frontend/build` from the host. That folder only exists after running `npm run build` locally, which needs Node installed.
- **Solution**: Compose now builds the frontend from its own Dockerfile (the same one CI uses). Added `frontend/.dockerignore` so `node_modules` isn't copied into the build.

### 2. Orders Cannot Create or List Orders Locally

- **Problem**: `POST /api/orders` and `GET /api/orders/my-orders` returned `500`.
- **Root Cause**: Two separate bugs. (1) The local init schema was missing the `orders.payment_status` column the code reads and writes. (2) Compose didn't set `PRODUCTS_SERVICE_URL` for orders, so it fell back to `localhost:3003`, which inside a container points at itself.
- **Solution**: Added the column to `database/init/20-init-schema.sql` (the k8s restore job already had it) and the env var to `docker-compose.yml`. The init script only runs on an empty volume, so the local Postgres volume must be recreated once.

### 3. Gateway Cannot Reach User Service Locally

- **Problem**: `/api/users/*` returned `504` ("Error occurred while trying to proxy").
- **Root Cause**: Compose set `USER_SERVICE_URL`, but the gateway reads `USERS_SERVICE_URL`, so it fell back to a wrong default (`localhost:3005`).
- **Solution**: Renamed the variable in `docker-compose.yml`. Kubernetes already used the correct name.

### 4. order-service Service Pointed at the Wrong Port (Kubernetes)

- **Problem**: In `gitops/k8s/backend/order-service.yml`, the Service targeted port `3002` while the container listens on `3004`.
- **Solution**: Changed `port` and `targetPort` to `3004`.

---

## Open Issues

Found in local testing (2026-09-29). Not fixed yet. Many of the high-severity items share one root cause: **the services don't agree on login and user identity.**

### High Severity

#### 1. Password `demo` Logs Into Any Account

- **Problem**: `POST /login` with password `demo` succeeds for any email, including existing accounts, and creates the account if it doesn't exist.
- **Root Cause**: A demo shortcut in `backend/services/auth/src/routes/auth.ts` (line 59) skips the password check.
- **Proposed Fix**: Remove the shortcut.

#### 2. Auth Token Is the User ID, Not a JWT

- **Problem**: The login "token" is the raw user UUID. `/me` trusts any ID it receives: no signature, no expiry, no real logout. The docs describe signed JWTs.
- **Root Cause**: `auth.ts` returns `user.id.toString()` as `token` and `refreshToken`. `jsonwebtoken` isn't installed in auth.
- **Proposed Fix**: Sign JWTs on login/register and verify them on `/me`.

#### 3. JWT Secret Has a Hard-Coded Default

- **Problem**: A token signed with `your-secret-key` was accepted by user-service during testing, so anyone can forge a token for any user.
- **Root Cause**: `JWT_SECRET` isn't set in Compose, Kubernetes, or `secrets.yml`, so user-service uses its fallback `'your-secret-key'`.
- **Proposed Fix**: Put `JWT_SECRET` in the Kubernetes Secret and Compose, and have services refuse to start without it.

#### 4. `users_db` Has No Tables (Local and EKS)

- **Problem**: Every user-service route fails with `relation "users" does not exist`.
- **Root Cause**: The local init script creates no tables in `users_db`. The k8s dump creates the database but leaves it empty, and the restore job doesn't touch it. user-service needs `users`, `addresses`, and `user_preferences`.
- **Proposed Fix**: Decide on a single users table (see #5), then create the tables user-service needs.

#### 5. Auth and User Service Don't Share Tokens or Users

- **Problem**: A logged-in user can never open their profile.
- **Root Cause**: Auth issues plain IDs while user-service requires JWTs. Auth stores users in `auth_db`, while user-service looks them up in `users_db`.
- **Proposed Fix**: One token format (JWT) and one source of truth for users.

#### 6. Orders Has No Authentication

- **Problem**: Anyone can create orders as any user, read anyone's history (`/my-orders?userId=...`), and change any order's status to any value (`"banana"` was accepted and saved).
- **Root Cause**: `backend/services/orders/src/routes/orders.ts` takes the user ID from the request body or query string and never checks a token. `PATCH /:id/status` has no auth or validation.
- **Proposed Fix**: Identify the user from the verified JWT. Restrict status changes to admins and to an allowed list of values.

#### 7. No Checkout in the Frontend

- **Problem**: Clicking **Checkout** returns to the Home page. The Orders page shows an error.
- **Root Cause**: `Cart.tsx` navigates to `/checkout`, but no such page or route exists, so the router's catch-all redirects home. `orderService.createOrder()` is never called. The Orders page calls `my-orders` without a user, so orders falls back to the invalid `demo-user-id`.
- **Proposed Fix**: Build a Checkout page after the identity fix (#2, #5, #6), since it depends on how the user is identified.

### Medium Severity

#### 8. order-service Always Fails and Crashes

- **Problem**: `POST /orders` crashes the Node process on every call; the container restarts.
- **Root Cause**: It calls a non-existent `/products` path on product-service, expects a plain array instead of `{success, data: {products}}`, stores UUIDs in an integer `product_id` column, and has no error handling. The gateway doesn't route to it, so nothing on the website uses it.
- **Proposed Fix**: Remove it, or rebuild it only if a second order service is needed for teaching.

#### 9. Orders Accepts Invalid Quantities and Ignores Stock

- **Problem**: Quantity `-3` created an order with a negative total (`-$5,697.00`). Quantity `999` was accepted with only 15 in stock, and inventory never decreases.
- **Proposed Fix**: Validate quantities (positive integers), check stock, and decrement inventory in the same database transaction as the order.

#### 10. Gateway Has No Rate Limiting and Open CORS

- **Problem**: 50 rapid requests all succeeded, so nothing slows password guessing on `/api/auth/login`. `Access-Control-Allow-Origin: *` allows any website.
- **Proposed Fix**: Add rate limiting (at least on auth routes) and restrict CORS to the frontend's origin.

#### 11. Gateway Metrics Create One Series per URL

- **Problem**: Each product ID becomes its own `route` label in `http_requests_total` (high cardinality), which bloats Prometheus and slows dashboards as traffic grows.
- **Proposed Fix**: Label by route pattern (`/api/products/:id`), not the raw URL.

#### 12. `GET /categories` Always Returns 500

- **Root Cause**: In `backend/services/product-service/src/routes/products.ts`, `/:id` is registered before `/categories`, so `"categories"` is treated as a product ID.
- **Proposed Fix**: Register `/categories` before `/:id`.

#### 13. Auth Uses a Shared `currentUser` Variable

- **Problem**: A module-level `currentUser` is overwritten on every login, so concurrent requests can mix users.
- **Proposed Fix**: Remove it and derive the user from the verified token per request.

### Low Severity and Cleanup

#### 14. Bad Input Returns 500

- **Problem**: Invalid product IDs, unknown products in orders, and malformed tokens return `500` instead of `400`/`401`/`404`. The gateway returns `500` when a service is down (should be `502`/`503`). These inflate 5xx error rates in Grafana.

#### 15. Leftover Files and Defaults

- Unused `server.js` / `server-fixed.js` in product-service and user-service (these contain routes that don't exist in the running services).
- The gateway's fallback URLs are mismatched (orders → `:3004`, users → `:3005`).
- `projects/boutique-microservices/.gitignore` ignores `.dockerignore` files.

---

