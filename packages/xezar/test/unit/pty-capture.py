#!/usr/bin/env python3
"""Run a command on a REAL terminal of a given size and print everything it wrote (#467, PR 3).

AC-08 is about what a person sees on a terminal: the compact banner, the bounded live table,
the redraws, and a cursor that is given back on the way out. None of that can be observed
through a pipe, because the program correctly refuses to draw any of it into one.

Node has no pseudo-terminal of its own, so this is the smallest thing that does. It:

  1. opens a pty and sets its window size BEFORE the child starts, so the very first thing the
     program measures is the size this script asked for;
  2. starts the command in its OWN session, so the interrupt below can only ever reach that one
     process group -- never this script, never a sibling, never anything else on the machine;
  3. reads for `seconds`, sends one SIGINT (what a person pressing Ctrl-C sends), drains the
     rest, and writes the raw bytes to stdout.

`--until <text>` makes `seconds` a settle window that starts when that text first appears,
instead of a wall clock that starts at exec. Without it the wait is exactly the fixed window it
always was. Boot cost belongs to the machine, not to the observation: on a busy host -- three
gate lanes at once -- a cold tsx boot ate the whole fixed window and the capture came back
empty, failing assertions about output the program had simply not reached yet. The marker wait
is bounded by MARKER_CEILING_SECONDS, after which the capture proceeds anyway and the test
reports the real absence.

Usage:  pty-capture.py <columns> <rows> <seconds> [--until <text>] <command> [args...]
Output: the raw terminal byte stream on stdout, escape sequences and all.
"""

import fcntl
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time


MARKER_CEILING_SECONDS = 120.0


def drain(master_fd, out, deadline, marker=None):
    """Read the terminal until `deadline`, the far end closes, or `marker` shows up."""
    while time.time() < deadline:
        readable, _, _ = select.select([master_fd], [], [], 0.2)
        if not readable:
            continue
        try:
            chunk = os.read(master_fd, 65536)
        except OSError:
            return False
        if not chunk:
            return False
        out.append(chunk)
        if marker and marker in b"".join(out):
            return True
    return False


def main():
    if len(sys.argv) < 5:
        sys.stderr.write(__doc__)
        return 2
    columns = int(sys.argv[1])
    rows = int(sys.argv[2])
    seconds = float(sys.argv[3])
    rest = sys.argv[4:]
    marker = None
    if rest and rest[0] == "--until":
        if len(rest) < 3:
            sys.stderr.write(__doc__)
            return 2
        marker = rest[1].encode()
        rest = rest[2:]
    command = rest
    if not command:
        sys.stderr.write(__doc__)
        return 2

    master_fd, slave_fd = pty.openpty()
    # Size first. A program that measures the terminal in its first milliseconds must find the
    # size this capture asked for, not the 0x0 a fresh pty starts with.
    fcntl.ioctl(master_fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))

    env = os.environ.copy()
    env["COLUMNS"] = str(columns)
    env["LINES"] = str(rows)
    env["TERM"] = env.get("TERM") or "xterm-256color"
    # A capture is not a CI run. These two would (correctly) turn the live table off.
    env.pop("CI", None)
    env.pop("NO_COLOR", None)

    child = subprocess.Popen(
        command,
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        env=env,
        close_fds=True,
        start_new_session=True,
    )
    os.close(slave_fd)

    out = []
    # The settle window starts once the program is up, so a slow boot costs the capture nothing.
    # With no marker asked for -- and when the marker never arrives -- this is the fixed window.
    if marker:
        drain(master_fd, out, time.time() + MARKER_CEILING_SECONDS, marker)
    drain(master_fd, out, time.time() + seconds)

    # Stop it the way a person does. `killpg` on the child's OWN session id -- never a name,
    # never a pattern: a pattern would match every unrelated process this user happens to run.
    try:
        os.killpg(os.getpgid(child.pid), signal.SIGINT)
    except (ProcessLookupError, PermissionError):
        pass
    drain(master_fd, out, time.time() + 4)

    try:
        child.wait(timeout=4)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(child.pid), signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        child.wait(timeout=4)

    os.close(master_fd)
    sys.stdout.buffer.write(b"".join(out))
    sys.stdout.buffer.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
