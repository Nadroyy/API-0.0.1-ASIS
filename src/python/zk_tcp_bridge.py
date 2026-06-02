#!/usr/bin/env python
import json
import sys
import time


def emit(payload, exit_code=0):
    print(json.dumps(payload, ensure_ascii=False))
    sys.exit(exit_code)


def emit_error(code, message, exit_code=1, status_code=502, details=None, action=None, duration_ms=None):
    error = {
        "code": code,
        "message": message,
        "statusCode": status_code,
    }
    if details is not None:
        error["details"] = details
    if action:
        error["action"] = action

    payload = {"ok": False, "error": error}
    if duration_ms is not None:
        payload["durationMs"] = duration_ms

    emit(payload, exit_code)


try:
    from zk import ZK, const  # type: ignore
except ModuleNotFoundError as exc:
    emit_error(
        "PYZK_NOT_INSTALLED",
        "Python package 'pyzk' no esta instalado. Instala dependencias con: pip install -r python/requirements-zk.txt",
        exit_code=2,
        status_code=503,
        details=str(exc),
    )


def load_payload():
    raw = sys.stdin.read().strip()
    if not raw:
        emit_error("EMPTY_PAYLOAD", "No se recibio payload JSON desde Node", exit_code=3, status_code=400)

    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        emit_error("INVALID_JSON", "Payload JSON invalido", exit_code=4, status_code=400, details=str(exc))


def build_client(payload):
    timeout_ms = int(payload.get("timeoutMs", 5000))
    timeout_seconds = max(1, round(timeout_ms / 1000))
    device_password = payload.get("devicePassword", 0) or 0

    return ZK(
        payload["ip"],
        port=int(payload.get("port", 4370)),
        timeout=timeout_seconds,
        password=int(device_password),
        force_udp=False,
        ommit_ping=False,
    )


def serialize_user(user):
    return {
        "uid": getattr(user, "uid", None),
        "userId": getattr(user, "user_id", None),
        "name": getattr(user, "name", None),
        "password": getattr(user, "password", None),
        "role": getattr(user, "privilege", None),
        "card": getattr(user, "card", None),
    }


def get_device_info(conn):
    info = {}

    for key, getter_name in {
        "deviceName": "get_device_name",
        "firmwareVersion": "get_firmware_version",
        "serialNumber": "get_serialnumber",
        "platform": "get_platform",
        "faceVersion": "get_face_version",
        "fpVersion": "get_fp_version",
        "userCount": "get_user_extend_fmt",
    }.items():
        getter = getattr(conn, getter_name, None)
        if callable(getter):
            try:
                info[key] = getter()
            except Exception as exc:
                info[key] = f"unavailable: {exc}"

    return info


def run_action(action, payload):
    zk = build_client(payload)
    conn = None
    started_at = time.time()

    try:
        conn = zk.connect()
        response_time_ms = round((time.time() - started_at) * 1000, 2)

        if action == "connect":
            emit(
                {
                    "ok": True,
                    "action": action,
                    "message": "Conexion pyzk exitosa",
                    "ip": payload["ip"],
                    "port": payload.get("port", 4370),
                    "responseTimeMs": response_time_ms,
                    "deviceInfo": get_device_info(conn),
                }
            )

        if action == "get-users":
            users = conn.get_users()
            emit(
                {
                    "ok": True,
                    "action": action,
                    "count": len(users),
                    "users": [serialize_user(user) for user in users],
                }
            )

        if action in {"create-user", "update-user"}:
            uid = int(payload["uid"])
            user_id = str(payload.get("userId") or payload["uid"])
            name = str(payload.get("name") or "")
            password = str(payload.get("password") or "")
            role = int(payload.get("role", 0))
            card_no = payload.get("cardNo", 0) or 0

            conn.disable_device()
            try:
                conn.set_user(
                    uid=uid,
                    name=name,
                    privilege=role if role is not None else const.USER_DEFAULT,
                    password=password,
                    group_id="",
                    user_id=user_id,
                    card=card_no,
                )
            finally:
                conn.enable_device()

            emit(
                {
                    "ok": True,
                    "action": action,
                    "message": "Usuario sincronizado en el dispositivo",
                    "user": {
                        "uid": uid,
                        "userId": user_id,
                        "name": name,
                        "passwordConfigured": bool(password),
                        "role": role,
                        "cardNo": card_no,
                    },
                }
            )

        if action == "delete-user":
            uid = int(payload["uid"])
            conn.disable_device()
            try:
                conn.delete_user(uid=uid)
            finally:
                conn.enable_device()

            emit(
                {
                    "ok": True,
                    "action": action,
                    "message": "Usuario eliminado del dispositivo",
                    "uid": uid,
                }
            )

        if action == "device-info":
            emit(
                {
                    "ok": True,
                    "action": action,
                    "deviceInfo": get_device_info(conn),
                }
            )

        emit_error("UNKNOWN_ACTION", f"Accion no soportada: {action}", exit_code=5, status_code=400, action=action)

    except Exception as exc:
        duration_ms = round((time.time() - started_at) * 1000, 2)
        emit_error(
            "PYZK_COMMAND_FAILED",
            str(exc),
            exit_code=1,
            status_code=503,
            action=action,
            duration_ms=duration_ms,
        )
    finally:
        if conn:
            try:
                conn.disconnect()
            except Exception:
                pass


def main():
    if len(sys.argv) < 2:
        emit_error("ACTION_REQUIRED", "Debes enviar una accion al bridge Python", exit_code=6, status_code=400)

    action = sys.argv[1].strip()
    payload = load_payload()
    if "ip" not in payload or not payload["ip"]:
        emit_error("IP_REQUIRED", "El payload debe incluir la IP del dispositivo", exit_code=7, status_code=400, action=action)

    run_action(action, payload)


if __name__ == "__main__":
    main()
