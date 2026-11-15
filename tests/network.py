"""Native HTTP/WS integration tests. Usage: python tests/network.py LISTEN_URL"""
import base64
import hashlib
import json
import os
import socket
import struct
import sys
import time
import unittest
from urllib.parse import urlparse

SYSTEM_AUDIO = '--system' in sys.argv
if SYSTEM_AUDIO:
    sys.argv.remove('--system')
URL = urlparse(sys.argv.pop(1))
HOST, PORT = URL.hostname, URL.port

def read_exact(s, n):
    b = bytearray()
    while len(b) < n:
        p = s.recv(n - len(b))
        if not p:
            raise EOFError('connection closed')
        b.extend(p)
    return bytes(b)

def headers(s):
    b = bytearray()
    while not b.endswith(b'\r\n\r\n'):
        b.extend(read_exact(s, 1))
        if len(b) > 16000:
            raise ValueError('unbounded HTTP header')
    return b.decode('ascii')

def http(path):
    with socket.create_connection((HOST, PORT), 3) as s:
        s.sendall(f'GET {path} HTTP/1.1\r\nHost: {HOST}:{PORT}\r\nConnection: close\r\n\r\n'.encode())
        data = bytearray()
        while True:
            p = s.recv(65536)
            if not p:
                break
            data.extend(p)
        h, body = bytes(data).split(b'\r\n\r\n', 1)
        return h.decode(), body

class WS:
    def __init__(self, bad_origin=False):
        self.s = socket.create_connection((HOST, PORT), 3)
        key = base64.b64encode(os.urandom(16)).decode()
        origin = 'http://evil.invalid' if bad_origin else f'http://{HOST}:{PORT}'
        self.s.sendall((f'GET /audio HTTP/1.1\r\nHost: {HOST}:{PORT}\r\n'
                       f'Upgrade: websocket\r\nConnection: Upgrade\r\nOrigin: {origin}\r\n'
                       f'Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n').encode())
        try:
            h = headers(self.s)
            assert '101 Switching Protocols' in h
            accept = base64.b64encode(hashlib.sha1((key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
            assert f'Sec-WebSocket-Accept: {accept}' in h
            self.s.settimeout(3)
        except BaseException:
            self.s.close()
            raise

    def close(self):
        self.s.close()

    def send(self, data, opcode=1, split=False):
        if isinstance(data, dict):
            data = json.dumps(data, separators=(',', ':')).encode()
        mask = os.urandom(4)
        n = len(data)
        frame = bytes([0x80 | opcode, 0x80 | n]) if n < 126 else bytes([0x80 | opcode, 0xfe]) + struct.pack('!H', n)
        frame += mask + bytes(x ^ mask[i % 4] for i, x in enumerate(data))
        if split:
            for i in range(0, len(frame), 3):
                self.s.sendall(frame[i:i+3])
        else:
            self.s.sendall(frame)

    def recv(self):
        h = read_exact(self.s, 2)
        assert h[0] & 128 and not h[1] & 128
        n = h[1] & 127
        if n == 126:
            n = struct.unpack('!H', read_exact(self.s, 2))[0]
        assert n != 127 and n < 8192
        return h[0] & 15, read_exact(self.s, n)

    def packet(self):
        for _ in range(400):
            op, b = self.recv()
            if op == 2:
                magic, seq, captured, play, duration, rate, frames, channels, fmt = struct.unpack('<4sIdddIHBB', b[:40])
                assert magic == b'LSA1' and rate == 48000 and channels == 2 and fmt == 1
                assert len(b) == 40 + frames * 4 and 0 < frames <= 480
                assert 49.999 <= play-captured <= 5000.001 and abs(duration-frames/48) < 1e-6
                return seq, captured, play, duration, b[40:]
        raise AssertionError('no audio packets')

class NativeServerTests(unittest.TestCase):
    def test_http(self):
        h, b = http('/')
        self.assertIn('200 OK', h)
        self.assertNotIn('Set-Cookie:', h)
        self.assertIn('开始收听'.encode(), b)
        h, script = http('/client.js')
        self.assertIn('200 OK', h)
        self.assertIn(b'playbackRate.value=1', script)
        h, _ = http('/missing')
        self.assertIn('404 Not Found', h)
        h, b = http('/status')
        self.assertIn('200 OK', h)
        status = json.loads(b)
        self.assertEqual(status['capturing'], 1)
        self.assertEqual(status['rendering'], 1)
        self.assertEqual(status['test'],not SYSTEM_AUDIO)

    def test_same_audio_and_deadlines(self):
        a, b = WS(), WS()
        try:
            pa, pb = a.packet(), b.packet()
            for _ in range(100):
                if pa[0] < pb[0]:
                    pa = a.packet()
                elif pb[0] < pa[0]:
                    pb = b.packet()
                else:
                    break
            self.assertEqual(pa, pb)
            for _ in range(100):
                pa, pb = a.packet(), b.packet()
                self.assertEqual(pa, pb)
        finally:
            a.close()
            b.close()

    def test_split_frame_sync_and_ping(self):
        a = WS()
        try:
            a.send({'type': 'sync', 't0': 100.5}, split=True)
            found = False
            for _ in range(300):
                op, b = a.recv()
                if op == 1 and json.loads(b).get('type') == 'sync':
                    m = json.loads(b)
                    self.assertEqual(m['t0'], 100.5)
                    self.assertGreaterEqual(m['t2'], m['t1'])
                    found = True
                    break
            self.assertTrue(found)
            a.send(b'keepalive', opcode=9)
            for _ in range(300):
                op, b = a.recv()
                if op == 10:
                    self.assertEqual(b, b'keepalive')
                    break
            else:
                self.fail('no pong')
        finally:
            a.close()

    def test_slow_listener_does_not_block_producer(self):
        slow, fast = WS(), WS()
        try:
            first = fast.packet()
            time.sleep(2)
            last = first
            for _ in range(250):
                last = fast.packet()
                if last[1] - first[1] > 1900:
                    break
            self.assertGreater(last[1]-first[1], 1900)
            _, b = http('/status')
            self.assertEqual(json.loads(b)['rendering'], 1)
        finally:
            slow.close()
            fast.close()

    def test_reconnect_joins_live(self):
        a = WS()
        before = a.packet()
        a.close()
        time.sleep(.25)
        b = WS()
        try:
            after = b.packet()
            self.assertGreater(after[1]-before[1], 150)
        finally:
            b.close()

    def test_unmasked_frames_rejected(self):
        a = WS()
        try:
            a.s.sendall(b'\x81\x02{}')
            self.assertRaises((EOFError, ConnectionResetError), self.drain, a)
        finally:
            a.close()

    @staticmethod
    def drain(a):
        while True:
            a.recv()

    def test_cross_origin_rejected(self):
        self.assertRaises((EOFError, ConnectionResetError), WS, True)

if __name__ == '__main__':
    unittest.main(verbosity=2)
