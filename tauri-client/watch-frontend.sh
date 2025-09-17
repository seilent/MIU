#!/bin/bash

# Watch for changes in frontend/ and copy to dist/
echo "👀 Watching frontend/ for changes..."

# Initial copy
cp frontend/* dist/
echo "✅ Initial copy complete"

# Watch for changes (requires inotify-tools: sudo apt install inotify-tools)
if command -v inotifywait &> /dev/null; then
    while inotifywait -e modify,create,delete frontend/; do
        cp frontend/* dist/
        echo "🔄 Frontend files updated"
    done
else
    echo "⚠️  inotify-tools not installed. Install with: sudo apt install inotify-tools"
    echo "💡 For now, run: cp frontend/* dist/ manually when you make changes"
fi