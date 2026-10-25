# Device Gateway: terminal connectivity

## 2026-10-26 incident

Gateway services and localhost HTTP were healthy. A firewall rule intended for
unused camera services also blocked terminal ISUP traffic on TCP 7091/7661/7663
and UDP 7661/7662. Removing those restrictions restored 10 of 12 devices; API and
Gateway UI agreed. The two remaining records were already offline before the
firewall change: `Test` and `Eski shahar 2-poliklinka`.

The permanent firewall script on the server is
`/usr/local/sbin/staffplus-camera-firewall`; its source is
`scripts/production-camera-firewall.sh`. The systemd unit
`staffplus-camera-firewall.service` runs it at boot and with Docker.
Changes to this source do not install themselves: review and install the script
explicitly before restarting that unit. It only adds rules; obsolete rules must
be removed separately. Never restore the previous shared terminal-port DROP.

## Diagnose before restart

1. Compare `curl --max-time 5 http://127.0.0.1:8080/` with external reachability.
   Admin HTTP 8080 is intentionally blocked from the internet.
2. Inspect `systemctl status DeviceGatewayService DeviceGatewayGuard` and
   `ss -lntup`; confirm registration listeners and established device connections.
3. Inspect `iptables -nvL INPUT` and IPv6 rules, including packet counters.
   Shared ISUP ports serve access-control terminals as well as cameras.
4. Query the gateway device list from the backend container using its existing
   configuration. Print only aggregate counts, never credentials or biometric data.
5. A Gateway failure means UNKNOWN terminal status; it is not proof that all
   devices are offline. `lastSeenAt` and `offlineSince` are historical values.
6. Verify user search on one online device before starting bulk synchronization.
   Reading the device list must not upload users, change faces or reboot devices.

## Admin UI

Use an SSH tunnel; do not expose the admin API publicly:

```bash
ssh -N -L 127.0.0.1:28183:127.0.0.1:8080 \
  -i ~/.ssh/staffplus-production-ed25519 root@95.111.252.83
```

Open `http://127.0.0.1:28183/` and log in normally. Closing the tunnel ends access.

## Data integrity

Gateway inventory is paginated, validated and deduplicated; partial or malformed
responses fail explicitly. Concurrent status callers share one in-flight request.
Transient failures during inventory reads get one bounded retry; authentication
failures do not. User searches retain one searchID across all pages and fail on
repeated pages instead of returning a truncated inventory.

The terminal AcsEvent history endpoint was verified read-only. This firmware
accepts explicit local offset timestamps (`+05:00`); a UTC `Z` request returned
HTTP 400. Historical replay has NOT been run. Event types/serial numbers and
idempotency must be verified before importing historical events into attendance.
Current bulk synchronization job state is process memory, unlike school-erp-saas
BullMQ persistence; a durable queue is a separate migration, not part of this fix.
