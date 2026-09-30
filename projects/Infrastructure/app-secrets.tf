# App secrets that must not live in the public Git repo.
# Created here (value only in Terraform state and the cluster) and
# referenced by the Deployments in gitops/k8s by name.

resource "random_password" "jwt_secret" {
  length  = 48
  special = false
}

# Signs and verifies login tokens (auth issues them; user-service and orders verify).
resource "kubernetes_secret_v1" "boutique_jwt" {
  provider = kubernetes.eks

  metadata {
    name      = "boutique-jwt"
    namespace = "boutique"
  }

  data = {
    JWT_SECRET = random_password.jwt_secret.result
  }
}
