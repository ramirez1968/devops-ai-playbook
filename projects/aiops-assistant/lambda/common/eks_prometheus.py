"""Query Prometheus through the EKS API server's service proxy.

Requests carry an IAM-signed EKS token (the same scheme as
`aws eks get-token`), so Prometheus never needs a public endpoint.
The Lambda role is mapped into the cluster with permission to proxy to
the Prometheus service only.
"""
import base64
import json
import os
import ssl
import tempfile
import urllib.parse
import urllib.request
from datetime import datetime, timezone

import boto3
from botocore.signers import RequestSigner

REGION = os.environ.get("AWS_REGION", "us-east-1")
CLUSTER_NAME = os.environ.get("CLUSTER_NAME", "eks-cluster")
# "<namespace>/<service>:<port>"
PROMETHEUS_SERVICE = os.environ.get(
    "PROMETHEUS_SERVICE", "monitoring/kube-prometheus-stack-prometheus:9090"
)

_cluster = None


def _cluster_info():
    """Endpoint and a TLS context that trusts the cluster's CA (cached per container)."""
    global _cluster
    if _cluster is None:
        cluster = boto3.client("eks", region_name=REGION).describe_cluster(name=CLUSTER_NAME)["cluster"]
        ca_file = tempfile.NamedTemporaryFile(delete=False, suffix=".crt")
        ca_file.write(base64.b64decode(cluster["certificateAuthority"]["data"]))
        ca_file.close()
        _cluster = {
            "endpoint": cluster["endpoint"],
            "ssl": ssl.create_default_context(cafile=ca_file.name),
        }
    return _cluster


def _eks_token():
    """Presigned STS GetCallerIdentity URL, encoded as an EKS bearer token (valid 60s)."""
    session = boto3.session.Session()
    sts = session.client("sts", region_name=REGION)
    signer = RequestSigner(
        sts.meta.service_model.service_id, REGION, "sts", "v4",
        session.get_credentials(), session.events,
    )
    url = signer.generate_presigned_url(
        {
            "method": "GET",
            "url": f"https://sts.{REGION}.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15",
            "body": {},
            "headers": {"x-k8s-aws-id": CLUSTER_NAME},
            "context": {},
        },
        region_name=REGION,
        expires_in=60,
        operation_name="",
    )
    return "k8s-aws-v1." + base64.urlsafe_b64encode(url.encode()).decode().rstrip("=")


def _get(path, params):
    cluster = _cluster_info()
    namespace, service = PROMETHEUS_SERVICE.split("/", 1)
    url = (
        f"{cluster['endpoint']}/api/v1/namespaces/{namespace}/services/{service}/proxy{path}"
        f"?{urllib.parse.urlencode(params)}"
    )
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {_eks_token()}"})
    with urllib.request.urlopen(req, timeout=10, context=cluster["ssl"]) as resp:
        return json.loads(resp.read())["data"]["result"]


def prometheus_query(query):
    """Run an instant PromQL query."""
    return _get("/api/v1/query", {"query": query})


def prometheus_range_query(query, hours_back, step="5m"):
    """Run a range PromQL query and return time-series data."""
    end = int(datetime.now(timezone.utc).timestamp())
    start = end - (int(hours_back) * 3600)
    return _get("/api/v1/query_range", {"query": query, "start": start, "end": end, "step": step})
