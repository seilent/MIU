#!/usr/bin/env python3
"""
Create a single-file Windows executable that bundles WebView2Loader.dll
"""

import os
import sys
import struct
import tempfile

def create_portable_exe(exe_path, dll_path, output_path):
    """Create a self-extracting executable that contains both files"""

    # Read the original executable
    with open(exe_path, 'rb') as f:
        exe_data = f.read()

    # Read the DLL if it exists
    dll_data = b''
    dll_exists = os.path.exists(dll_path)
    if dll_exists:
        with open(dll_path, 'rb') as f:
            dll_data = f.read()
        print(f"Including WebView2Loader.dll in portable executable")
    else:
        print(f"WebView2Loader.dll not included - will be downloaded on demand")

    # Create a simple self-extracting stub
    stub_code = b'''
import sys
import os
import tempfile
import struct

# Extract embedded files
def extract_files():
    # Read this script to find embedded data
    with open(sys.argv[0], 'rb') as f:
        data = f.read()

    # Find the embedded data marker
    marker = b"EMBEDDED_DATA_START"
    start_pos = data.find(marker)
    if start_pos == -1:
        raise Exception("No embedded data found")

    start_pos += len(marker)

    # Read sizes
    exe_size = struct.unpack('<Q', data[start_pos:start_pos+8])[0]
    dll_size = struct.unpack('<Q', data[start_pos+8:start_pos+16])[0]

    # Extract files
    exe_data = data[start_pos+16:start_pos+16+exe_size]
    dll_data = data[start_pos+16+exe_size:start_pos+16+exe_size+dll_size]

    # Create temp directory
    temp_dir = tempfile.mkdtemp()

    exe_path = os.path.join(temp_dir, "miu.exe")
    dll_path = os.path.join(temp_dir, "WebView2Loader.dll")

    with open(exe_path, 'wb') as f:
        f.write(exe_data)

    # Only write DLL if it was bundled (dll_size > 0)
    if dll_size > 0:
        with open(dll_path, 'wb') as f:
            f.write(dll_data)

    # Make executable and run
    os.chmod(exe_path, 0o755)
    os.execv(exe_path, [exe_path] + sys.argv[1:])

if __name__ == "__main__":
    extract_files()
'''

    # Pack the data
    packed_data = b"EMBEDDED_DATA_START"
    packed_data += struct.pack('<Q', len(exe_data))  # exe size
    packed_data += struct.pack('<Q', len(dll_data))  # dll size
    packed_data += exe_data
    packed_data += dll_data

    # Write the portable executable
    with open(output_path, 'wb') as f:
        f.write(stub_code)
        f.write(packed_data)

    # Make executable
    os.chmod(output_path, 0o755)

    print(f"Created portable executable: {output_path}")
    print(f"Size: {len(stub_code) + len(packed_data)} bytes")

if __name__ == "__main__":
    if len(sys.argv) != 4:
        print("Usage: create-portable.py <exe_path> <dll_path> <output_path>")
        sys.exit(1)

    exe_path, dll_path, output_path = sys.argv[1:4]

    if not os.path.exists(exe_path):
        print(f"Error: {exe_path} not found")
        sys.exit(1)

    dll_exists = os.path.exists(dll_path)
    if not dll_exists:
        print(f"Warning: {dll_path} not found - creating executable without bundled WebView2")
        print("Note: WebView2 will be downloaded automatically when the application runs")

    create_portable_exe(exe_path, dll_path if dll_exists else "", output_path)