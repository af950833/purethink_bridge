# Purethink Bridge

Local bridge server for Purethink/PureSync devices.

The bridge accepts the device's TLS MQTT connection locally, mirrors traffic to the
manufacturer MQTT broker when available, and mirrors the same `/things/...` topics
to an internal MQTT broker for Home Assistant.

## Run

```bash
docker build -t purethink-bridge:latest .

docker run -d \
  --name purethink-bridge \
  --restart unless-stopped \
  -p 8885:8885 \
  -p 8080:8080 \
  -v /opt/purethink-bridge/data:/data \
  purethink-bridge:latest
```

Open the dashboard:

```text
http://<server-ip>:8080
```

## Router DNAT

Redirect only the Purethink device to the bridge:

```bash
iptables -t nat -I PREROUTING 1 \
  -s <device-ip> -d 221.149.135.231 \
  -p tcp --dport 8885 \
  -j DNAT --to-destination <server-ip>:8885

iptables -t nat -I POSTROUTING 1 \
  -s <device-ip> -d <server-ip> \
  -p tcp --dport 8885 \
  -j MASQUERADE
```

## Data

Runtime data is stored under `/data`:

- `config.json`: dashboard/internal MQTT settings
- `certs/server.crt`, `certs/server.key`: generated TLS certificate

## MQTT Flow

```text
Device -> Bridge -> Manufacturer MQTT
Device -> Bridge -> Internal MQTT
Manufacturer MQTT -> Bridge -> Device
Internal MQTT -> Bridge -> Device
```

Messages mirrored from the device to internal MQTT are loop-suppressed so they are
not sent straight back to the device.
