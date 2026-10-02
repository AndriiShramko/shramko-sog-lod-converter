"""Independent read-back of the ZIP64 test archives with Python's zipfile (CRC-checked)."""
import sys
import zipfile
from pathlib import Path

d = Path(sys.argv[1])

z = zipfile.ZipFile(d / 'zip64-many.zip')
names = z.namelist()
assert len(names) == 70000, len(names)
assert z.read('d6/f69999.txt') == b'entry 69999'
print('ok   python zipfile reads 70,000-entry archive')

z = zipfile.ZipFile(d / 'zip64-big.zip')
info = z.getinfo('after/meta.json')
assert info.header_offset > 0xFFFFFFFF, info.header_offset
assert z.read('after/meta.json') == b'{"after":4GiB}'
assert z.read('lod-meta.json') == b'{"ok":true}'
bad = z.testzip()  # reads every entry and checks its CRC
assert bad is None, bad
print('ok   python zipfile reads >4 GiB archive, all CRCs valid, offset', info.header_offset)
