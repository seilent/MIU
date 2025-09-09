#!/bin/bash

# Stop MIU Application Bundle

# Function to kill process by PID file
kill_by_pid() {
    if [ -f "$1" ]; then
        PID=$(cat "$1")
        if kill -0 "$PID" 2>/dev/null; then
            kill "$PID"
            rm "$1"
            echo "Stopped process $PID"
        else
            rm "$1"
        fi
    fi
}

# Stop all services
kill_by_pid /home/seilent/MIU/pids/backend.pid
kill_by_pid /home/seilent/MIU/pids/prisma.pid
kill_by_pid /home/seilent/MIU/pids/frontend.pid

echo "MIU application stopped"
