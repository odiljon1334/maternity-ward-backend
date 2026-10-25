#!/usr/bin/env bash
# Device Gateway uses TCP 7091/7661/7663 and UDP 7661/7662 for terminals too.
# NEVER classify these as unused camera ports. Admin 8080 is accessed by SSH tunnel.
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
ensure_rule() {
  local fw="$1" chain="$2"
  shift 2
  "$fw" -w -C "$chain" "$@" 2>/dev/null || "$fw" -w -I "$chain" 1 "$@"
}
for fw in iptables ip6tables; do
  ensure_rule "$fw" INPUT -i eth0 -p tcp \
    -m multiport --dports 554,1935,8080,8554 \
    -m conntrack --ctstate NEW -j DROP
  ensure_rule "$fw" DOCKER-USER -i eth0 -p tcp \
    -m multiport --dports 1935,8554 \
    -m conntrack --ctstate NEW -j DROP
done
