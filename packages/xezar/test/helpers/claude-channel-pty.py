# Real interactive Claude Channels acceptance: pipes <-> PTY, signals forwarded only to our child.
import os, pty, sys, select, fcntl, termios, struct, signal
argv = sys.argv[1:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 50, 160, 0, 0))
os.kill(pid, signal.SIGWINCH)
def fwd(sig, frm):
    try: os.kill(pid, sig)
    except ProcessLookupError: pass
for s in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP): signal.signal(s, fwd)
inp = sys.stdin.fileno(); out = sys.stdout.fileno(); open_in = True
while True:
    rl = [fd] + ([inp] if open_in else [])
    try: r, _, _ = select.select(rl, [], [], 0.5)
    except InterruptedError: continue
    if fd in r:
        try: data = os.read(fd, 65536)
        except OSError: break
        if not data: break
        os.write(out, data)
    if open_in and inp in r:
        data = os.read(inp, 65536)
        if not data: open_in = False
        else: os.write(fd, data)
    wp, st = os.waitpid(pid, os.WNOHANG)
    if wp: break
try: _, st = os.waitpid(pid, 0)
except ChildProcessError: st = 0
sys.exit(os.waitstatus_to_exitcode(st) if st else 0)
