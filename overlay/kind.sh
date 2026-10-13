#!/usr/bin/env bash
# `just overlay-kind up|down|kubectl <host> [args]`: the overlay on a kind cluster on another machine, over ssh.
# The machine needs rootless Podman and Nix; kind and kubectl come from the overlay's pinned nixpkgs. Its files
# live in ~/adi-overlay-kind there, which `down` removes with the cluster, its network and its node image.
# `up` loads overlay/.image, so run `just overlay-image` first.
set -euo pipefail
[[ $# -ge 2 ]] || { echo "usage: overlay/kind.sh up|down|kubectl <host> [kubectl args]" >&2; exit 2; }
cmd="$1" host="$2"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
rev="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["nodes"]["nixpkgs"]["locked"]["rev"])' "$here/flake.lock")"

remote() { # runs on the host: remote <nixpkgs rev> <step> [args]
  set -euo pipefail
  local d="$HOME/adi-overlay-kind" rev="$1" step="$2" ips svc
  shift 2
  # rootless Podman: userns=host, since an account-wide userns=auto stops kind's node container
  export KIND_EXPERIMENTAL_PROVIDER=podman CONTAINERS_CONF_OVERRIDE="$d/containers.conf" KUBECONFIG="$d/kubeconfig"
  PATH="$(nix build --no-link --print-out-paths "github:NixOS/nixpkgs/$rev#kind" "github:NixOS/nixpkgs/$rev#kubectl" |
    sed 's|$|/bin|' | paste -sd:):$PATH"
  mkdir -p "$d"
  case "$step" in
  cluster)
    printf '[containers]\nuserns = "host"\n' >"$d/containers.conf"
    cat >"$d/cluster.yaml"
    # without DNS on the network: a stale aardvark-dns entry can hold the gateway's port 53
    podman network exists kind ||
      podman network create -d bridge --disable-dns --ipv6 --subnet fc00:f853:ccd:e793::/64 kind >/dev/null
    kind get clusters 2>/dev/null | grep -qx adi || kind create cluster --config "$d/cluster.yaml" --wait 120s
    ;;
  load)
    cat >"$d/adi.tar"
    kind load image-archive "$d/adi.tar" --name adi
    ;;
  apply)
    kubectl apply -f -
    # the hosted stack's API-server egress policy, with this cluster's endpoint and Service addresses
    ips="$(kubectl -n default get endpointslice kubernetes -o jsonpath='{.endpoints[*].addresses[*]}')"
    svc="$(kubectl -n default get service kubernetes -o jsonpath='{.spec.clusterIP}')"
    kubectl apply -f - <<EOF
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: {name: adi-sms-api-egress, namespace: adi-sms}
spec:
  podSelector: {matchLabels: {app.kubernetes.io/name: web}}
  policyTypes: [Egress]
  egress:
    - to: [$(printf '{ipBlock: {cidr: %s/32}}\n' $ips | paste -sd, -)]
      ports: [{port: 6443, protocol: TCP}]
    - to: [{ipBlock: {cidr: $svc/32}}]
      ports: [{port: 443, protocol: TCP}]
EOF
    kubectl -n adi-sms rollout status deployment/web --timeout=180s
    ;;
  kubectl) kubectl "$@" ;;
  down)
    kind delete cluster --name adi
    podman network rm kind >/dev/null 2>&1 || true
    podman rmi "$1" >/dev/null 2>&1 || true
    rm -rf "$d"
    ;;
  esac
}
on() { ssh -o BatchMode=yes -o ConnectTimeout=10 "$host" "$(declare -f remote); remote $rev $*"; }

case "$cmd" in
up)
  [[ -e "$here/.image" ]] || { echo "overlay-kind: no overlay/.image; run just overlay-image" >&2; exit 1; }
  on cluster <"$here/k8s/kind/cluster.yaml"
  gzip -dc "$here/.image" | on load
  nix develop "$here" --command kubectl kustomize "$here/k8s/kind" | on apply
  ;;
down) on down "$(sed -n 's/^ *image: *//p' "$here/k8s/kind/cluster.yaml")" ;;
kubectl) on kubectl "$(printf '%q ' "${@:3}")" ;;
*) echo "usage: overlay/kind.sh up|down|kubectl <host> [kubectl args]" >&2 && exit 2 ;;
esac
