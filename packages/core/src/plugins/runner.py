#!/usr/bin/env python3
"""NDJSON-RPC runner: reads {id, method, params} lines from stdin,
writes {id, result|error} lines to stdout."""
import base64
import importlib.util
import json
import os
import sys
import threading


def log(msg):
    sys.stderr.write("[runner] %s\n" % msg)
    sys.stderr.flush()


def load_plugin(plugin_dir):
    entry = os.path.join(plugin_dir, "plugin.py")
    if not os.path.exists(entry):
        raise FileNotFoundError("plugin.py not found in " + plugin_dir)
    spec = importlib.util.spec_from_file_location("proxy_plugin", entry)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def handle(mod, method, params):
    ctx = dict(params)

    def ctx_log(msg):
        sys.stderr.write("[plugin] %s\n" % msg)
        sys.stderr.flush()

    ctx["log"] = ctx_log
    fn = getattr(mod, method, None)
    if fn is None:
        return None
    result = fn(ctx)
    if result is None:
        return None
    return result


def main():
    plugin_dir = sys.argv[1] if len(sys.argv) > 1 else "."
    try:
        mod = load_plugin(plugin_dir)
    except Exception as e:  # noqa: BLE001
        log("load failed: %s" % e)
        sys.exit(1)

    log("loaded %s" % plugin_dir)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue
        rid = req.get("id")
        try:
            result = handle(mod, req.get("method"), req.get("params") or {})
            out = {"id": rid, "result": result}
        except Exception as e:  # noqa: BLE001
            out = {"id": rid, "error": str(e)}
        sys.stdout.write(json.dumps(out, default=str) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
