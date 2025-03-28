#!/bin/bash

# Script to forcefully kill the MIU server process

# Find the process ID by looking for the node process running our server
PID=$(ps aux | grep "node.*dist/index.js" | grep -v grep | awk '{print $2}')

if [ -z "$PID" ]; then
  echo "No running MIU server process found"
  exit 0
fi

echo "Found MIU server process with PID: $PID"
echo "Sending SIGINT signal to attempt graceful shutdown..."

# First try SIGINT for graceful shutdown
kill -SIGINT $PID

# Wait up to 5 seconds for graceful shutdown
echo "Waiting up to 5 seconds for graceful shutdown..."
for i in {1..5}; do
  if ! ps -p $PID > /dev/null; then
    echo "Process terminated gracefully"
    exit 0
  fi
  sleep 1
  echo "Still waiting... ($i/5)"
done

# If process is still running, force kill with SIGKILL
if ps -p $PID > /dev/null; then
  echo "Process didn't terminate gracefully. Forcing termination with SIGKILL..."
  kill -9 $PID
  echo "Process terminated forcefully"
else
  echo "Process terminated gracefully"
fi 