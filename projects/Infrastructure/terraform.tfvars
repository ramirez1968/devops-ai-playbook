region   = "us-east-1"
vpc_name = "EKS-Demo-VPC"
vpc_cidr = "10.1.0.0/16"

subnets = [
  {
    name              = "subnet-1"
    cidr_block        = "10.1.1.0/24"
    availability_zone = "us-east-1a"
  },

  {
    name              = "subnet-2",
    cidr_block        = "10.1.2.0/24",
    availability_zone = "us-east-1b"
  },
  {
    name              = "subnet-3",
    cidr_block        = "10.1.3.0/24",
    availability_zone = "us-east-1c"
  }
]

cluster_name    = "eks-cluster"
node_group_name = "eks-nodes-private"

instance_types = ["m7i-flex.large"]
capacity_type  = "ON_DEMAND"

desired_size = 2
min_size     = 1
max_size     = 2

disk_size = 30

repositories = [
  "frontend",
  "gateway",
  "auth",
  "order-service",
  "orders",
  "product-service",
  "user-service"
]
private_subnet_cidrs = ["10.1.11.0/24", "10.1.12.0/24", "10.1.13.0/24"]

# Postgres' EBS volume lives in us-east-1b, so a node must always run there.
# Two zones with two nodes puts one node in each.
node_availability_zones = ["us-east-1a", "us-east-1b"]
