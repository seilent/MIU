#!/usr/bin/env python3
"""
Test script for MIU client synchronization
Helps verify that the sync mechanisms are working correctly
"""

import sys
import json
import time
import argparse
from urllib.request import urlopen, Request
from urllib.error import URLError

def test_server_connection(server_url: str) -> bool:
    """Test basic connection to server"""
    base_url = server_url.rstrip('/')
    if not base_url.endswith('/backend'):
        base_url = f"{base_url}/backend"

    status_url = f"{base_url}/api/music/minimal-status"

    try:
        with urlopen(status_url, timeout=5) as response:
            data = json.loads(response.read().decode())
            print(f"✓ Server connection: OK")
            print(f"  Status: {data.get('status', 'unknown')}")
            if data.get('track'):
                print(f"  Current track: {data['track']['title']}")
                print(f"  Position: {data.get('position', 0)}s")
            else:
                print("  No track playing")
            return True
    except Exception as e:
        print(f"✗ Server connection failed: {e}")
        return False

def test_sse_connection(server_url: str, duration: int = 10) -> bool:
    """Test SSE connection and event reception"""
    base_url = server_url.rstrip('/')
    if not base_url.endswith('/backend'):
        base_url = f"{base_url}/backend"

    sse_url = f"{base_url}/api/music/state/live"

    print(f"Testing SSE connection for {duration} seconds...")

    try:
        request = Request(sse_url)
        request.add_header('Accept', 'text/event-stream')
        request.add_header('Cache-Control', 'no-cache')

        start_time = time.time()
        event_count = 0

        with urlopen(request, timeout=duration + 5) as response:
            print("✓ SSE connection established")

            event_type = None
            event_data = ""
            buffer = ""

            while time.time() - start_time < duration:
                try:
                    # Read with shorter timeout to avoid hanging
                    chunk = response.read(1024)
                    if not chunk:
                        break

                    buffer += chunk.decode('utf-8')

                    # Process complete lines
                    while '\n' in buffer:
                        line, buffer = buffer.split('\n', 1)
                        line = line.strip()

                        if line.startswith('event: '):
                            event_type = line[7:]
                        elif line.startswith('data: '):
                            event_data = line[6:]
                        elif line.startswith('id: '):
                            pass  # Ignore ID for now
                        elif line == '':
                            # End of event
                            if event_type and event_data:
                                event_count += 1
                                try:
                                    data = json.loads(event_data)
                                    print(f"  Received {event_type} event: {len(event_data)} bytes")

                                    if event_type == 'state':
                                        if data.get('currentTrack'):
                                            track = data['currentTrack']
                                            print(f"    Track: {track['title']}")
                                            print(f"    Position: {data.get('position', 0)}s")
                                        print(f"    Status: {data.get('status', 'unknown')}")
                                    elif event_type == 'sync_play':
                                        print(f"    Sync play for track: {data.get('trackId')}")
                                        print(f"    Position: {data.get('position', 0)}s")
                                        print(f"    Server time: {data.get('serverTime', 0)}")
                                        print(f"    Play at: {data.get('playAt', 0)}")
                                    elif event_type == 'heartbeat':
                                        print("    Heartbeat received")
                                except json.JSONDecodeError:
                                    print(f"  Invalid JSON in {event_type} event")

                            event_type = None
                            event_data = ""

                except Exception as e:
                    print(f"  Read error: {e}")
                    break

        print(f"✓ SSE test completed: received {event_count} events")
        return event_count > 0

    except Exception as e:
        print(f"✗ SSE connection failed: {e}")
        return False

def test_network_latency(server_url: str, iterations: int = 5) -> float:
    """Test network latency to server"""
    base_url = server_url.rstrip('/')
    if not base_url.endswith('/backend'):
        base_url = f"{base_url}/backend"

    status_url = f"{base_url}/api/music/minimal-status"  # Use status endpoint for latency test

    latencies = []

    print(f"Testing network latency ({iterations} iterations)...")

    for i in range(iterations):
        start_time = time.perf_counter()

        try:
            request = Request(status_url)
            request.add_header('User-Agent', 'MIU-Sync-Test/1.0')

            with urlopen(request, timeout=5) as response:
                response.read()

            round_trip_time = time.perf_counter() - start_time
            one_way_latency = round_trip_time / 2
            latencies.append(one_way_latency)

            print(f"  Ping {i+1}: {one_way_latency*1000:.2f}ms")

        except Exception as e:
            print(f"  Ping {i+1}: failed ({e})")

    if latencies:
        avg_latency = sum(latencies) / len(latencies)
        min_latency = min(latencies)
        max_latency = max(latencies)

        print(f"✓ Latency results:")
        print(f"  Average: {avg_latency*1000:.2f}ms")
        print(f"  Min: {min_latency*1000:.2f}ms")
        print(f"  Max: {max_latency*1000:.2f}ms")

        return avg_latency
    else:
        print("✗ All latency tests failed")
        return 0.0

def main():
    parser = argparse.ArgumentParser(description='Test MIU client synchronization')
    parser.add_argument('--server', required=True,
                      help='MIU server URL (e.g., https://miu.gacha.boo)')
    parser.add_argument('--sse-duration', type=int, default=10,
                      help='Duration to test SSE connection (seconds)')
    parser.add_argument('--latency-tests', type=int, default=5,
                      help='Number of latency test iterations')

    args = parser.parse_args()

    print(f"Testing MIU synchronization for server: {args.server}")
    print("=" * 60)

    # Test 1: Basic connection
    if not test_server_connection(args.server):
        print("Basic connection failed. Cannot continue tests.")
        return 1

    print()

    # Test 2: Network latency
    avg_latency = test_network_latency(args.server, args.latency_tests)

    print()

    # Test 3: SSE connection
    sse_success = test_sse_connection(args.server, args.sse_duration)

    print()
    print("=" * 60)
    print("Test Summary:")

    if avg_latency > 0:
        print(f"✓ Network latency: {avg_latency*1000:.2f}ms average")
    else:
        print("✗ Network latency test failed")

    if sse_success:
        print("✓ SSE connection working")
    else:
        print("✗ SSE connection failed")

    # Recommendations
    print()
    print("Recommendations:")

    if avg_latency > 0.2:  # > 200ms
        print("⚠ High network latency detected. Sync accuracy may be reduced.")
    elif avg_latency > 0.1:  # > 100ms
        print("⚠ Moderate network latency. Sync should work but may have minor delays.")
    else:
        print("✓ Network latency is good for synchronization.")

    if not sse_success:
        print("✗ SSE connection failed. Real-time sync will not work.")
        print("  Check firewall and proxy settings.")

    return 0 if sse_success else 1

if __name__ == "__main__":
    sys.exit(main())