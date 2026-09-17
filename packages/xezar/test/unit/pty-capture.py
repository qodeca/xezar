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
  3. reads for `seconds` after the command's first output (waiting up to `seconds` more for it
     to start at all), sends one SIGINT (what a person pressing Ctrl-C sends), drains the
     rest, and writes the raw bytes to stdout.

Usage:  pty-capture.py <columns> <rows> <seconds> <command> [args...]
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


def drain(master_fd, out, window, boot_wait=0.0):
    """Read the terminal for `window` seconds, or until the far end closes.

    With `boot_wait`, the window starts at the FIRST byte instead of at the call, and the whole
    call still ends after `window + boot_wait` at the latest. The window is meant to watch a
    program that is already up; on a loaded machine the child's own start-up ate all of it and
    the capture came back empty, which reads as "the program printed nothing" rather than "it
    had not started yet". The window is unchanged -- it just begins where it always meant to.
    """
    now = time.time()
    deadline = now + window + boot_wait
    if boot_wait <= 0:
        deadline = now + window
    started = boot_wait <= 0
    while time.time() < deadline:
        readable, _, _ = select.select([master_fd], [], [], 0.2)
        if not readable:
            continue
        try:
            chunk = os.read(master_fd, 65536)
        except OSError:
            return
        if not chunk:
            return
        if not started:
            started = True
            deadline = min(deadline, time.time() + window)
        out.append(chunk)


def main():
    if len(sys.argv) < 5:
        sys.stderr.write(__doc__)
        return 2
    columns = int(sys.argv[1])
    rows = int(sys.argv[2])
    seconds = float(sys.argv[3])
    command = sys.argv[4:]

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
    # Up to `seconds` of extra patience for the child to say anything at all, then `seconds` of
    # watching it -- see `drain`.
    drain(master_fd, out, seconds, boot_wait=seconds)

    # Stop it the way a person does. `killpg` on the child's OWN session id -- never a name,
    # never a pattern: a pattern would match every unrelated process this user happens to run.
    try:
        os.killpg(os.getpgid(child.pid), signal.SIGINT)
    except (ProcessLookupError, PermissionError):
        pass
    drain(master_fd, out, 4)

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
