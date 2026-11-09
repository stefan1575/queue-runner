"""Draws the runner's toast icon, queue_runner/assets/icon.png (standard library only): a
rounded teal square with three bars of a queue, the first one leaving. Run again to redraw."""
import os
import struct
import zlib

N = 128
BG, BAR, LEAD = (17, 94, 89), (236, 253, 245), (252, 211, 77)


def inside_rounded(x, y, r=26):
    cx = min(max(x, r), N - 1 - r)
    cy = min(max(y, r), N - 1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def bar(x, y, top, left, right, h=14):
    if not top <= y < top + h:
        return False
    r = h / 2
    cy = top + r - 0.5
    cx = min(max(x, left + r), right - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def pixel(x, y):
    if not inside_rounded(x, y):
        return (0, 0, 0, 0)
    if bar(x, y, 30, 24, 76) or bar(x, y, 57, 24, 76) or bar(x, y, 84, 24, 76):
        return (*BAR, 255)
    # the one leaving the queue: an arrow head right of the middle bar
    if 84 <= x <= 104 and abs(y - 63.5) <= (104 - x) * 0.9:
        return (*LEAD, 255)
    return (*BG, 255)


def png(path):
    raw = b''.join(b'\x00' + b''.join(bytes(pixel(x, y)) for x in range(N)) for y in range(N))

    def chunk(kind, data):
        return (struct.pack('>I', len(data)) + kind + data
                + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff))
    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', N, N, 8, 6, 0, 0, 0))
                + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))


if __name__ == '__main__':
    png(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                     'queue_runner', 'assets', 'icon.png'))
