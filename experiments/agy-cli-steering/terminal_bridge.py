"""POSIX PTY bridge for the native agy experiment; stdin/stdout are JSON lines."""

import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time


def stop(_signum, _frame):
    raise SystemExit


pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 35, 120, 0, 0))
print(json.dumps({"pid": pid}), flush=True)
pending = b""
try:
    while True:
        readable, _, _ = select.select([fd, sys.stdin], [], [], 0.2)
        if fd in readable:
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            print(json.dumps({"data": data.decode("utf8", "replace")}), flush=True)
        if sys.stdin in readable:
            data = os.read(sys.stdin.fileno(), 65536)
            if not data:
                break
            pending += data
            while b"\n" in pending:
                line, pending = pending.split(b"\n", 1)
                action = json.loads(line)
                if "text" in action:
                    os.write(fd, action["text"].encode())
finally:
    # pty.fork creates a new session. Only this probe's group is terminated.
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(pid, sig)
        except ProcessLookupError:
            break
        if sig == signal.SIGTERM:
            time.sleep(0.1)
    os.close(fd)
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass
