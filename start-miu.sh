#!/bin/bash

# Start MIU Application Bundle

# Start backend
cd /home/seilent/MIU/backend
nohup npm start > /home/seilent/MIU/logs/backend.log 2>&1 &
echo $! > /home/seilent/MIU/pids/backend.pid

# Start prisma studio
nohup npm run prisma:studio > /home/seilent/MIU/logs/prisma.log 2>&1 &
echo $! > /home/seilent/MIU/pids/prisma.pid

# Start frontend
cd /home/seilent/MIU/frontend
nohup npm start > /home/seilent/MIU/logs/frontend.log 2>&1 &
echo $! > /home/seilent/MIU/pids/frontend.pid

echo "MIU application started"
