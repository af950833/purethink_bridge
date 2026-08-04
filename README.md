# Purethink Bridge

Purethink 환기장치를 로컬망에서 안정적으로 사용하기 위한 MQTT 브릿지 서버입니다.

제조사 MQTT 서버가 동작할 때는 기존 앱 사용성을 유지하고, 제조사 서버가 죽어도 Home Assistant와 내부 MQTT를 통해 로컬 제어가 가능하도록 만드는 구성을 목표로 합니다.

## 전체 구조

```text
Purethink 기기
  -> 공유기 DNAT
  -> Purethink Bridge Docker :8885
       -> 제조사 MQTT dapt.iptime.org:8885
       -> 내부 MQTT 서버 :1883
            -> Home Assistant purethink custom component
```

브릿지는 다음 역할을 합니다.

- 기기에서 들어오는 TLS MQTT 연결 수신
- 기기 상태를 제조사 MQTT로 전달
- 기기 상태를 내부 MQTT로 전달
- 제조사 MQTT에서 들어온 명령을 기기로 전달
- 내부 MQTT에서 들어온 명령을 기기로 전달
- 웹 대시보드에서 연결 상태와 payload stream 표시

## 주의사항

이 절차는 사용자가 소유한 기기를 로컬망에서 사용하기 위한 방법입니다.

- 펌웨어 수정과 OTA는 항상 위험이 있습니다.
- 잘못된 펌웨어를 올리면 기기가 부팅하지 않을 수 있습니다.
- 공유기 DNAT 설정을 잘못하면 다른 장비의 통신에 영향을 줄 수 있습니다.
- 먼저 제조사 서버와 앱에서 기기가 정상 동작하는 상태를 확인한 뒤 진행하세요.
- 가능하면 공유기 DNAT는 특정 기기 IP에만 적용하세요.

## 준비물

- Ubuntu 서버
- Docker
- Git
- Home Assistant
- 내부 MQTT 서버, 예: Mosquitto `1883`
- Purethink 기기의 IP 주소
- Purethink 기기의 device id, 예: `DIV01-ABCDEF`
- Purethink 기기 펌웨어 `ver.220706.1630_DIV01.bin`
- 공유기에서 iptables DNAT 설정 가능

이 문서의 예시는 다음 값을 사용합니다. 본인 환경에 맞게 바꿔서 사용하세요.

```text
Ubuntu 서버 IP: 192.168.0.4
기기 IP: 192.168.0.67
제조사 MQTT IP: 221.149.135.231(CMD창에서 ping dapt.iptime.org 로 확인)
브릿지 MQTT 포트: 8885
브릿지 대시보드 포트: 33301
내부 MQTT 포트: 1883
```

## 1. 펌웨어 다운로드

제조사 펌웨어는 과거 다음 경로에서 확인되었습니다.

```text
http://dapt.iptime.org:6002/firmware/ver.220706.1630_DIV01.bin
```

다른 모델/라인업 펌웨어도 아래 경로에서 다운로드 가능한 경우가 있습니다.

```text
http://dapt.iptime.org:6002/firmware/ver.220706.1630_THESOOP.bin
http://dapt.iptime.org:6002/firmware/ver.211231.1400_DIV02.bin
http://dapt.iptime.org:6002/firmware/ver.220307.1130_AC01.bin
```

단, 이 문서의 패치 위치와 스크립트는 `ver.220706.1630_DIV01.bin`에서만 검증되었습니다. `THESOOP`, `DIV02`, `AC01` 펌웨어에는 그대로 적용하지 마세요. 해당 모델은 사용자가 직접 디스어셈블/분석해서 인증서 검증 루틴, 버전 문자열, checksum 위치를 확인한 뒤 별도 패치해야 합니다.

Ubuntu 서버나 작업 PC에서 다운로드합니다.

```bash
curl -L \
  -o ver.220706.1630_DIV01.bin \
  http://dapt.iptime.org:6002/firmware/ver.220706.1630_DIV01.bin
```

다운로드한 파일 크기를 확인합니다.

```bash
ls -l ver.220706.1630_DIV01.bin
```

예상 크기:

```text
509952 bytes
```

## 2. 펌웨어 수정

Purethink 기기는 제조사 MQTT에 TLS로 접속합니다. 로컬 브릿지 서버의 자체 인증서도 받아들이게 하려면 펌웨어의 인증서 fingerprint 검증 루틴을 우회해야 합니다.

확인된 펌웨어 기준:

```text
원본 파일: ver.220706.1630_DIV01.bin
수정 버전: ver.220706.1633_DIV01.bin
패치 위치: 0x0000c82c
원본 바이트: 12 c1 90 c2
수정 바이트: 0c 02 0d f0
버전 문자열: ver.220706.1630_DIV01 -> ver.220706.1633_DIV01
체크섬 위치: ESP8266 image checksum byte
```

아래 Python 스크립트는 위 패치를 적용하고 ESP8266 image checksum을 다시 계산합니다.

```bash
cat > patch_purethink_fw.py <<'PY'
import hashlib
import pathlib
import struct

src = pathlib.Path("ver.220706.1630_DIV01.bin")
out = pathlib.Path("ver.220706.1633_DIV01.bin")
fw = bytearray(src.read_bytes())

app_base = 0x1000
magic, segcnt, flash_mode, flash_size_freq, entry = struct.unpack_from("<BBBBI", fw, app_base)
if magic != 0xE9:
    raise SystemExit(f"Unexpected ESP image magic: {magic:#x}")

off = 8
segments = []
for i in range(segcnt):
    load, size = struct.unpack_from("<II", fw, app_base + off)
    off += 8
    data_fw_off = app_base + off
    off += size
    segments.append((load, size, data_fw_off))

def vma_to_fw(addr):
    for load, size, data_fw_off in segments:
        if load <= addr < load + size:
            return data_fw_off + (addr - load)
    raise ValueError(f"VMA not found: {addr:#x}")

patch_off = vma_to_fw(0x4020C82C)
expected = bytes.fromhex("12 c1 90 c2")
patched = bytes.fromhex("0c 02 0d f0")
if bytes(fw[patch_off:patch_off + 4]) != expected:
    raise SystemExit(f"Unexpected bytes at {patch_off:#x}: {fw[patch_off:patch_off + 4].hex(' ')}")
fw[patch_off:patch_off + 4] = patched

old_ver = b"ver.220706.1630_DIV01"
new_ver = b"ver.220706.1633_DIV01"
count = fw.count(old_ver)
if count != 2:
    raise SystemExit(f"Expected 2 version strings, found {count}")
fw[:] = fw.replace(old_ver, new_ver)

checksum_off = app_base + (((off + 16) & ~15) - 1)
chk = 0xEF
aoff = 8
for i in range(segcnt):
    load, size = struct.unpack_from("<II", fw, app_base + aoff)
    aoff += 8
    for b in fw[app_base + aoff:app_base + aoff + size]:
        chk ^= b
    aoff += size
fw[checksum_off] = chk

out.write_bytes(fw)
print("output:", out)
print("size:", len(fw))
print("sha256:", hashlib.sha256(fw).hexdigest())
print("checksum:", hex(chk), "at", hex(checksum_off))
PY

python3 patch_purethink_fw.py
```

검증된 `1633` 파일 정보:

```text
파일명: ver.220706.1633_DIV01.bin
크기: 509952 bytes
SHA256: 9c20bd2d5b113ea38b2fcac483ec7b5a08ff9bf0f494338a1f6ea1134769f343
```

이미 검증된 `ver.220706.1633_DIV01.bin` 파일을 보관하고 있다면 패치 스크립트를 다시 실행하지 않아도 됩니다. 직접 해당 파일을 다운로드하거나 복사해서 OTA 서버의 `firmware/` 폴더에 넣으면 됩니다.

```bash
mkdir -p ~/purethink-ota/firmware
cp ver.220706.1633_DIV01.bin ~/purethink-ota/firmware/
```

본인이 배포 권한을 가진 범위에서 GitHub Release 또는 개인 저장소에 `ver.220706.1633_DIV01.bin`을 보관해 두었다면, 아래처럼 직접 내려받아 사용할 수도 있습니다.

```bash
mkdir -p ~/purethink-ota/firmware
curl -L \
  -o ~/purethink-ota/firmware/ver.220706.1633_DIV01.bin \
  '<ver.220706.1633_DIV01.bin 다운로드 URL>'
```

## 3. OTA 서버 준비

기기 펌웨어 업데이트는 제조사 OTA 서버 `dapt.iptime.org:6002` 요청을 잠시 로컬 OTA 서버로 DNAT해서 진행합니다.

임시 OTA 서버 폴더를 만듭니다.

```bash
mkdir -p ~/purethink-ota/firmware
cp ver.220706.1633_DIV01.bin ~/purethink-ota/firmware/
cd ~/purethink-ota
```

간단한 OTA 서버를 만듭니다.

```bash
cat > purethink_ota_server.py <<'PY'
#!/usr/bin/env python3
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

HOSTNAME = "dapt.iptime.org"
PORT = 6002
VERSION_DIV01 = "ver.220706.1633_DIV01"
FIRMWARE_NAME = f"{VERSION_DIV01}.bin"
FIRMWARE_PATH = f"/firmware/{FIRMWARE_NAME}"
ROOT = Path(__file__).resolve().parent
FIRMWARE_FILE = ROOT / "firmware" / FIRMWARE_NAME

def firmware_payload():
    return {
        "LastVersionDiv": VERSION_DIV01,
        "LastVersionThesoop": "ver.220706.1630_THESOOP",
        "LastVersionDiv02": "ver.211231.1400_DIV02",
        "LastVersionAC01": "ver.220307.1130_AC01",
        "UpdateDate": "220706.1633",
        "Hostname": HOSTNAME,
        "Port": PORT,
        "PathDiv": FIRMWARE_PATH,
        "PathThesoop": "/firmware/ver.220706.1630_THESOOP.bin",
        "PathDiv02": "/firmware/ver.211231.1400_DIV02.bin",
        "PathAC01": "/firmware/ver.220307.1130_AC01.bin",
        "PathTestDiv": FIRMWARE_PATH,
        "PathTestThesoop": "/firmware/ver.220706.1630_THESOOP.bin",
        "PathTestDiv02": "/firmware/ver.220404.1900_DIV02.bin",
        "PathTestAC01": "/firmware/ver.220307.1130_AC01.bin",
    }

class Handler(BaseHTTPRequestHandler):
    def _send_json(self, obj):
        body = json.dumps(obj, separators=(",", ":")).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _send_firmware(self):
        data = FIRMWARE_FILE.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Connection", "close")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _handle(self):
        parsed = urlparse(self.path)
        print(self.client_address[0], self.command, self.path, flush=True)

        if parsed.path.startswith("/firmware/") and parsed.path.endswith(".bin"):
            return self._send_firmware()

        lower_path = parsed.path.lower()
        if "firmwareversioncombined" in lower_path or lower_path.endswith("/version/combined"):
            return self._send_json(firmware_payload())
        if "firmware" in lower_path:
            return self._send_json(firmware_payload())

        return self._send_json({"ok": True})

    def do_GET(self):
        self._handle()

    def do_POST(self):
        self._handle()

    def do_PUT(self):
        self._handle()

    def do_HEAD(self):
        self._handle()

if __name__ == "__main__":
    if not FIRMWARE_FILE.exists():
        raise SystemExit(f"missing firmware: {FIRMWARE_FILE}")
    print(f"serving {FIRMWARE_FILE} on 0.0.0.0:{PORT}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
PY
```

OTA 서버를 실행합니다.

```bash
python3 purethink_ota_server.py
```

별도 터미널에서 응답을 확인합니다.

```bash
curl -s http://127.0.0.1:6002/version/combined
curl -I http://127.0.0.1:6002/firmware/ver.220706.1633_DIV01.bin
```

퓨어싱크 앱을 실행하여 기기 선택 후 설정 화면까지 들어갑니다.

## 4. OTA용 공유기 DNAT

앱과 기기가 제조사 OTA 서버 대신 로컬 OTA 서버를 보게 하려면 공유기에서 `6002`를 잠시 DNAT합니다.

제조사 OTA 서버 IP를 확인합니다.

```bash
nslookup dapt.iptime.org
```

예시에서는 `221.149.135.231`을 사용합니다.

공유기 SSH에서 아래 명령을 그대로 실행합니다.

```bash
iptables -t nat -I PREROUTING 1 ! -s 192.168.0.4 -d 221.149.135.231 -p tcp --dport 6002 -j DNAT --to-destination 192.168.0.4:6002

iptables -t nat -I POSTROUTING 1 ! -s 192.168.0.4 -d 192.168.0.4 -p tcp --dport 6002 -j MASQUERADE

conntrack -D -d 221.149.135.231 -p tcp --dport 6002 2>/dev/null || true
```

규칙이 정상적으로 추가되었는지 확인합니다.

```bash
iptables -t nat -L PREROUTING --line-numbers -n -v
iptables -t nat -L POSTROUTING --line-numbers -n -v
```

앱에서 버전 정보로 들어가서 펌웨어 업데이트를 실행합니다.

업데이트가 끝나면 기기 현재 버전이 `1633`으로 보이는지 확인합니다. 앱에서 100% 진행 후 실패로 표시되더라도 기기가 실제로 업데이트되는 경우가 있으므로, 앱의 현재 버전 표시를 확인하세요.

## 5. OTA DNAT 원복

펌웨어 업데이트가 끝나면 반드시 `6002` DNAT를 제거합니다.

공유기 SSH에서 아래 명령을 그대로 실행합니다.

```bash
iptables -t nat -D PREROUTING ! -s 192.168.0.4 -d 221.149.135.231 -p tcp --dport 6002 -j DNAT --to-destination 192.168.0.4:6002 2>/dev/null || true

iptables -t nat -D POSTROUTING ! -s 192.168.0.4 -d 192.168.0.4 -p tcp --dport 6002 -j MASQUERADE 2>/dev/null || true

conntrack -D -d 221.149.135.231 -p tcp --dport 6002 2>/dev/null || true
```

규칙이 삭제되었는지 확인합니다.

```bash
iptables -t nat -L PREROUTING --line-numbers -n -v
iptables -t nat -L POSTROUTING --line-numbers -n -v
```

OTA 서버도 종료합니다.

```bash
pkill -f purethink_ota_server.py 2>/dev/null || true
```

## 6. 브릿지 서버 설치

Ubuntu 서버에서 저장소를 받습니다.

```bash
sudo mkdir -p /opt/purethink-bridge
sudo chown -R $USER:$USER /opt/purethink-bridge

git clone https://github.com/af950833/purethink_bridge.git /opt/purethink-bridge
cd /opt/purethink-bridge
```

이미 clone되어 있다면 pull 합니다.

```bash
cd /opt/purethink-bridge
git pull --ff-only
```

Docker 이미지를 빌드합니다.

```bash
docker build -t purethink_bridge:latest .
```

컨테이너를 실행합니다.

```bash
mkdir -p /opt/purethink-bridge/data

docker rm -f purethink_bridge 2>/dev/null || true

docker run -d \
  --name purethink_bridge \
  --restart unless-stopped \
  -p 8885:8885 \
  -p 33301:33301 \
  -v /opt/purethink-bridge/data:/data \
  purethink_bridge:latest
```

상태 확인:

```bash
docker ps --filter name=purethink_bridge
docker logs --tail 50 purethink_bridge
```

대시보드:

```text
http://<Ubuntu 서버 IP>:33301
```

예:

```text
http://192.168.0.4:33301
```

## 7. Docker pull 방식(현재는 사용 불가)

현재 이 저장소는 소스에서 직접 Docker build하는 방식을 기본으로 합니다.

만약 Docker Hub 또는 GHCR에 이미지를 배포했다면 아래처럼 pull/run 방식으로 사용할 수 있습니다.

```bash
docker pull ghcr.io/af950833/purethink_bridge:latest

docker rm -f purethink_bridge 2>/dev/null || true

docker run -d \
  --name purethink_bridge \
  --restart unless-stopped \
  -p 8885:8885 \
  -p 33301:33301 \
  -v /opt/purethink-bridge/data:/data \
  ghcr.io/af950833/purethink_bridge:latest
```

## 8. 내부 MQTT 설정

대시보드에서 내부 MQTT 정보를 입력합니다.

```text
Enabled: 체크
Host: 내부 MQTT 서버 IP
Port: 1883
Username: 내부 MQTT ID
Password: 내부 MQTT PW
Client ID: purethink-bridge
Subscribe Topic: /things/#
```

저장 후 대시보드 상태가 아래처럼 보여야 합니다.

```text
Manufacturer MQTT: connected
Internal MQTT: connected
Device: offline
```

아직 기기 DNAT를 걸기 전이면 `Device: offline`이 정상입니다.

## 9. MQTT용 공유기 DNAT

펌웨어 `1633` 업데이트가 끝난 기기는 로컬 브릿지의 자체 인증서를 받아들일 수 있습니다.

이제 기기의 제조사 MQTT 접속을 브릿지 서버로 DNAT합니다.

공유기 SSH에서 아래 명령을 그대로 실행합니다.

```bash
iptables -t nat -I PREROUTING 1 -s 192.168.0.67 -p tcp --dport 8885 -j DNAT --to-destination 192.168.0.4:8885

conntrack -D -s 192.168.0.67 -p tcp --dport 8885
```

규칙이 정상적으로 추가되었는지 확인합니다.

```bash
iptables -t nat -L PREROUTING --line-numbers -n -v
```

대시보드에서 확인합니다.

```text
Device: connected
Manufacturer MQTT: connected
Internal MQTT: connected
```

payload stream에 `/things/<device-id>/shadow` 메시지가 표시되면 정상입니다.

## 10. MQTT DNAT 원복

브릿지 테스트를 중단하거나 제조사 서버 직접 연결로 되돌리고 싶으면 `8885` DNAT를 제거합니다.

공유기 SSH에서 아래 명령을 그대로 실행합니다.

```bash
iptables -t nat -D PREROUTING -s 192.168.0.67 -p tcp --dport 8885 -j DNAT --to-destination 192.168.0.4:8885

conntrack -D -s 192.168.0.67 -p tcp --dport 8885
```

규칙이 삭제되었는지 확인합니다.

```bash
iptables -t nat -L PREROUTING --line-numbers -n -v
```

기기가 제조사 서버로 다시 붙었는지 확인합니다.

```bash
conntrack -L 2>/dev/null | grep '192.168.0.67.*8885'
```

## 11. Home Assistant 설정

Home Assistant custom component `af950833/purethink`는 내부 MQTT 서버를 선택하도록 수정된 버전을 사용합니다.

새 통합 추가 시:

```text
MQTT 연결 방식: Local MQTT
Host: 내부 MQTT 서버 IP
Port: 1883
Username: 내부 MQTT ID
Password: 내부 MQTT PW
Device ID: DIV01-xxxx
```

브릿지는 내부 MQTT에 기존 제조사 토픽과 같은 형태로 publish합니다.

```text
/things/DIV01-xxxx/shadow
```

따라서 Home Assistant 컴포넌트는 제조사 MQTT 대신 내부 MQTT만 바라보면 됩니다.

## 12. 동작 확인 명령

브릿지 컨테이너 로그:

```bash
docker logs -f purethink_bridge
```

대시보드 API:

```bash
curl -s http://127.0.0.1:33301/api/status
```

내부 MQTT 확인:

```bash
mosquitto_sub -h 127.0.0.1 -p 1883 \
  -u '<MQTT_ID>' -P '<MQTT_PW>' \
  -t '/things/#' -v
```

브릿지 포트 확인:

```bash
ss -ltnp | grep -E ':8885|:33301'
```

공유기 DNAT 확인:

```bash
iptables -t nat -S PREROUTING | grep 8885
iptables -t nat -S POSTROUTING | grep 8885
```

## 13. 업데이트 방법

소스 업데이트:

```bash
cd /opt/purethink-bridge
git pull --ff-only
docker build -t purethink_bridge:latest .
docker rm -f purethink_bridge
docker run -d \
  --name purethink_bridge \
  --restart unless-stopped \
  -p 8885:8885 \
  -p 33301:33301 \
  -v /opt/purethink-bridge/data:/data \
  purethink_bridge:latest
```

## 14. 문제 해결

### Device가 offline

- 공유기 `8885` DNAT가 있는지 확인
- 기기 IP가 맞는지 확인
- 기기가 펌웨어 `1633`인지 확인
- 브릿지 컨테이너가 `8885`를 listen 중인지 확인

```bash
ss -ltnp | grep 8885
```

### Internal MQTT가 reconnecting

- 내부 MQTT host/port 확인
- ID/PW 확인
- Mosquitto ACL 또는 password file 확인

### Manufacturer MQTT가 offline

- 제조사 서버 장애일 수 있습니다.
- 이 경우에도 `Device <-> Bridge <-> Internal MQTT <-> Home Assistant` 경로는 유지되어야 합니다.

### 앱 제어는 안 되지만 HA 제어는 됨

- 제조사 MQTT가 장애일 수 있습니다.
- 이 프로젝트의 목적은 이런 상황에서 로컬 제어를 유지하는 것입니다.

### payload stream에 다른 기기 메시지가 많이 보임

브릿지는 기기가 접속한 후 해당 기기 토픽만 제조사 MQTT에서 구독합니다.

```text
/things/<connected-client-id>/#
```

컨테이너 재시작 직후 기기가 아직 붙지 않은 상태에서는 제조사 MQTT 구독이 제한적으로 동작합니다. 기기가 연결되면 해당 기기 토픽으로 좁혀집니다.
