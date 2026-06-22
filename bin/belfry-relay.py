#!/usr/bin/env python3
"""
belfry-relay — ultra-thin per-session stdio relay (the memory-saving spoke).

Claude Code spawns ONE of these per session (configured as the `belfry` MCP
server in .mcp.json). Instead of a full ~75MB Node process, this ~8MB python
process just pipes the session's stdio JSON-RPC to a SINGLE shared broker
(`belfry-broker.js`) over a unix socket. The broker runs the real channel-role
logic for every session. N sessions -> N tiny relays + 1 broker, not N Node
runtimes.

Channels are stdio-only, so each session still needs *a* stdio server — but it
can be a transparent relay. From Claude's view this IS the MCP server: the
broker's `initialize` reply (with the claude/channel capability) and its pushed
`notifications/claude/channel` flow straight back through the pipe.

Resilience (closes the broker-is-a-SPOF gap): we generate ONE stable session_id
and reconnect to the broker if the connection drops (e.g. a broker restart),
re-sending the handshake with reconnect=true. The broker re-registers under the
same id, and the daemon preserves any messages queued during the outage. We
only exit when Claude closes our stdin (the session is over).

Handshake (first line, then raw byte relay): {session_id, slug_hint, cwd, env,
broadcast, reconnect}. The broker derives the authoritative slug (it has
lib/slug.js); we pass cwd + env hints so it can.
"""
import os
import sys
import socket
import select
import json
import time
import uuid

def state_dir():
    d = (os.environ.get("BELFRY_STATE_DIR") or "").strip()
    if d:
        return d
    xdg = os.environ.get("XDG_STATE_HOME") or os.path.join(os.path.expanduser("~"), ".local", "state")
    return os.path.join(xdg, "belfry")

SOCK = os.environ.get("BELFRY_BROKER_SOCK") or os.path.join(state_dir(), "broker.sock")
SESSION_ID = str(uuid.uuid4())          # stable across reconnects within this process
CONNECT_TIMEOUT_S = 120                 # how long to keep retrying the broker before giving up

def hint_slug():
    for k in ("CLAUDE_SESSION_SLUG", "CLAUDELIKE_BAR_NAME"):
        v = os.environ.get(k)
        if v and v.strip():
            return v.strip()
    return os.path.basename(os.getcwd()) or "unknown"

def handshake(reconnect):
    return (json.dumps({
        "session_id": SESSION_ID,
        "slug_hint": hint_slug(),
        "cwd": os.getcwd(),
        "broadcast": os.environ.get("BELFRY_BROADCAST", ""),
        "env": {k: os.environ[k] for k in ("CLAUDE_SESSION_SLUG", "CLAUDELIKE_BAR_NAME") if k in os.environ},
        "reconnect": reconnect,
    }) + "\n").encode("utf-8")

def connect():
    """Connect to the broker, retrying while it (re)starts. None if it never comes up."""
    deadline = time.time() + CONNECT_TIMEOUT_S
    while time.time() < deadline:
        try:
            s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            s.connect(SOCK)
            return s
        except (FileNotFoundError, ConnectionRefusedError):
            time.sleep(0.5)
    return None

def main():
    stdin_fd = sys.stdin.fileno()
    pending = b""          # stdin bytes read but not yet delivered (buffered across a drop)
    reconnect = False
    stdin_eof = False

    while not stdin_eof:
        s = connect()
        if s is None:
            sys.stderr.write(f"belfry-relay: broker {SOCK} unavailable after {CONNECT_TIMEOUT_S}s\n")
            sys.exit(1)
        try:
            s.sendall(handshake(reconnect))
            if pending:
                s.sendall(pending)
                pending = b""
        except OSError:
            try: s.close()
            except OSError: pass
            continue       # broker died during handshake — retry
        reconnect = True   # any subsequent connect is a reconnect
        sock_fd = s.fileno()
        drop = False
        while not drop and not stdin_eof:
            try:
                r, _, _ = select.select([stdin_fd, sock_fd], [], [])
            except (OSError, ValueError):
                break
            if stdin_fd in r:
                try:
                    data = os.read(stdin_fd, 65536)
                except OSError:
                    data = b""
                if not data:          # Claude closed our stdin -> session over
                    stdin_eof = True
                    break
                try:
                    s.sendall(data)
                except OSError:       # broker dropped mid-send -> buffer + reconnect
                    pending = data
                    drop = True
                    break
            if sock_fd in r:
                try:
                    data = s.recv(65536)
                except OSError:
                    data = b""
                if not data:          # broker dropped -> reconnect
                    drop = True
                    break
                try:
                    os.write(1, data)
                except OSError:
                    stdin_eof = True  # our stdout is gone -> nothing to do but exit
                    break
        try:
            s.close()
        except OSError:
            pass
    sys.exit(0)

if __name__ == "__main__":
    main()
