import errno
import fcntl
import json
import os
from pathlib import Path
import pty
import struct
import subprocess
import sys
import termios

PTY_READ_CHUNK_BYTES = 65536
PTY_ROWS = 24
PTY_COLUMNS = 80
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", PTY_ROWS, PTY_COLUMNS, 0, 0))


def attach_terminal():
    os.setsid()
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)


child = subprocess.Popen(
    ["/bin/bash", "-c", sys.argv[1]],
    stdin=slave,
    stdout=slave,
    stderr=slave,
    preexec_fn=attach_terminal,
)
Path(sys.argv[2]).write_text(json.dumps({"pid": child.pid, "runnerPid": os.getpid()}))
os.close(slave)
try:
    with open(sys.argv[3], "wb") as stream:
        while True:
            try:
                data = os.read(master, PTY_READ_CHUNK_BYTES)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not data:
                break
            stream.write(data)
finally:
    os.close(master)
sys.exit(child.wait())
