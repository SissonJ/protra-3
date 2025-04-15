#!/bin/bash

cd /root/protra-3
ts-node --esm ./index.ts >> ./logs/"$(date +%Y-%m).log" 2>&1
